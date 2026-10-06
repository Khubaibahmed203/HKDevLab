// Phase 4 Hardening #7 — audit honesty for unobserved pages.
// Before: an audit finished 'complete' with a normal score even when its START page was never observed (the analyzer only reports on
// pages it fetched, so every page-level issue silently vanished), and compareToPreviousAudit() counted any issue missing from the new
// audit as "resolved" even when its page had simply not been looked at. Now:
//   * a crawl whose start page was not observed (no response, or not HTML) ends as a FAILED audit — no score, nothing recorded;
//     a start page that WAS fetched (any HTTP status, as HTML) or that robots.txt excludes stays a normal audit;
//   * a previous page-level issue is "resolved" only if the new audit really observed that page (same test Hardening #5 uses);
//     otherwise it is reported as `notRecheckedCount`. Page-less issues, and the unchanged/introduced counts, are untouched.
// Part 1 drives the real executeScan() over a local site that changes between audits; Part 2 is a store-level matrix for the
// comparison; Part 3 reads audits through the real SEO router; Part 4 proves the wiring from source. SQLite and pg-mem (the
// PostgreSQL adapter) both run Parts 1-3.
// Run: node server/test-seo-audit-honesty.mjs
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { newDb } from 'pg-mem';

const DB = join(tmpdir(), 'hk-audit-honesty-test.db');
for (const s of ['', '-wal', '-shm']) rmSync(DB + s, { force: true });
Object.assign(process.env, { SQLITE_PATH: DB, SMTP_HOST: '', SETUP_TOKEN: '', GOOGLE_CLIENT_ID: '', NODE_ENV: 'development', SEO_CRAWL_DELAY_MS: '1' });
for (const k of ['DATABASE_URL', 'PAGESPEED_API_KEY', 'ANTHROPIC_API_KEY', 'SEO_MAX_PAGES', 'SEO_MAX_DEPTH', 'SEO_REQUEST_TIMEOUT_MS', 'SEO_STALE_AUDIT_MS']) delete process.env[k];

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { (cond ? pass++ : fail++); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };
const watchdog = setTimeout(() => { console.log('FAIL  watchdog: the test did not finish in time'); process.exit(1); }, 170_000);
watchdog.unref();

const { createStore } = await import(new URL('./db.js', import.meta.url).href);
const { executeScan, compareToPreviousAudit } = await import(new URL('./seo/jobs.js', import.meta.url).href);
const { createSeoRouter } = await import(new URL('./seo/routes.js', import.meta.url).href);
const src = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withEnv = async (env, fn) => {
  const prev = {};
  for (const [k, v] of Object.entries(env)) { prev[k] = process.env[k]; process.env[k] = v; }
  try { return await fn(); } finally { for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
};

const sockets = new Set(), servers = [];
const listen = async (handler) => {
  const server = http.createServer(handler);
  server.on('connection', (s) => sockets.add(s));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return { server, host: `127.0.0.1:${server.address().port}`, base: `http://127.0.0.1:${server.address().port}/` };
};
const closedBase = async () => { const s = http.createServer(); await new Promise((r) => s.listen(0, '127.0.0.1', r)); const port = s.address().port; await new Promise((r) => s.close(r)); return `http://127.0.0.1:${port}/`; };

/* ═════════ a local site whose state can change between audits ═════════ */
const words = (seed) => Array.from({ length: 70 }, (_, i) => `${seed}${i}`).join(' ');
const html = ({ title, desc, h1, links = '', canon }) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><meta name="description" content="${desc}"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="canonical" href="${canon}"><script type="application/ld+json">{"@context":"https://schema.org","@type":"WebPage","name":"${h1}"}</script></head><body><h1>${h1}</h1><p>${words(h1.replace(/\W/g, ''))}</p>${links}</body></html>`;
const HOME_TITLE = 'The Home Page Of A Perfectly Healthy Site', FIXED_ABOUT = 'About This Perfectly Healthy Site Team';

async function makeWorld(store, label) {
  const st = { home: 'ok', homeLinksAbout: true, about: 'short-title', robots: 'allow', robotsAboutBlocked: false, sitemap: 'ok' };
  const w = await listen((req, res) => {
    const b = `http://${req.headers.host}`;
    const send = (code, type, body) => { res.writeHead(code, { 'content-type': type }); res.end(body); };
    if (req.url === '/robots.txt') {
      if (st.robots === 'missing') return send(404, 'text/plain', 'no');
      return send(200, 'text/plain', st.robots === 'disallow-all' ? 'User-agent: *\nDisallow: /\n' : `User-agent: *\n${st.robotsAboutBlocked ? 'Disallow: /about\n' : 'Allow: /\n'}`);
    }
    if (req.url === '/sitemap.xml') return st.sitemap === 'ok' ? send(200, 'application/xml', `<?xml version="1.0"?><urlset><url><loc>${b}/</loc></url><url><loc>${b}/about</loc></url></urlset>`) : send(404, 'text/plain', 'no');
    if (req.url === '/') {
      if (st.home === '503-html') return send(503, 'text/html', '<html><body>Service unavailable</body></html>');
      if (st.home === '503-text') return send(503, 'text/plain', 'maintenance');
      if (st.home === 'json') return send(200, 'application/json', '{"ok":true}');
      return send(200, 'text/html', html({ title: HOME_TITLE, desc: 'A description for the home page that is comfortably longer than the fifty character minimum.', h1: 'Home', canon: `${b}/`, links: st.homeLinksAbout ? '<a href="/about">About us</a>' : '' }));
    }
    if (req.url === '/about') {
      if (st.about === 'hang') return;                                   // never answers
      if (st.about === '404-html') return send(404, 'text/html', '<html><body>Not found</body></html>');
      return send(200, 'text/html', html({ title: st.about === 'fixed' ? FIXED_ABOUT : 'About', desc: 'A description for the about page that is comfortably longer than the fifty character minimum.', h1: 'About', canon: `${b}/about`, links: '<a href="/">Home</a>' }));
    }
    send(404, 'text/plain', 'no');
  });
  return { st, base: w.base, host: w.host, site: await store.ensureWebsite(w.host, `honesty-${label}-${w.host}`) };
}
const audit = async (store, w, { base = w.base, env = {} } = {}) => {
  const a = await store.createAuditIfNoneActive(w.site.id, { baseUrl: base, pagesPlanned: 100 });
  const run = await Promise.race([withEnv(env, () => executeScan(store, w.site.id, a.id, base)).then(() => 'done'), sleep(25_000).then(() => 'HUNG')]);
  return { audit: await store.getAudit(a.id), hung: run === 'HUNG' };
};
const issues = (store, w, a) => store.listIssues({ websiteId: w.site.id, auditId: a.id, limit: 2000 });
const keyOf = (i) => `${i.type}:${i.page_id ?? ''}`;
const keys = (list) => new Set(list.map(keyOf));
const aboutPage = async (store, w) => (await store.listPages(w.site.id)).find((p) => p.url === `${w.base}about`);

/* ═════════ Parts 1 and 3: end to end, on each backend ═════════ */
async function endToEnd(label, store) {
  const T = (n) => `[${label}] ${n}`;

  // the router every part of the admin UI reads audits through (it adds `comparison` only to COMPLETE audits)
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: 1, email: 'honesty@x.test', role: 'admin' }; next(); });
  app.use('/api/admin/seo', createSeoRouter(store, { limiter: { take: async () => false } }));
  app.use((err, req, res, next) => res.status(500).json({ ok: false }));
  const api = await listen(app);
  const viaRouter = async (id) => (await fetch(`${api.base}api/admin/seo/scans/${id}`)).json();

  /* S1. healthy -> healthy: nothing changes */
  {
    const w = await makeWorld(store, 's1');
    const a = await audit(store, w), b = await audit(store, w);
    const ia = await issues(store, w, a.audit), cmp = (await viaRouter(b.audit.id)).audit.comparison;
    ok(T('S1. healthy -> healthy: both audits complete with a real score, equal because nothing changed'), !a.hung && !b.hung && a.audit.status === 'complete' && b.audit.status === 'complete' && typeof a.audit.score === 'number' && b.audit.score === a.audit.score, JSON.stringify([a.audit.status, b.audit.status, a.audit.score, b.audit.score]));
    ok(T('S1. …comparison unchanged: nothing resolved, nothing introduced, every issue unchanged, nothing "not rechecked"'), cmp && cmp.previousAuditId === a.audit.id && cmp.resolvedCount === 0 && cmp.introducedCount === 0 && cmp.unchangedCount === keys(ia).size && cmp.notRecheckedCount === 0 && keys(ia).size > 0, JSON.stringify(cmp));
  }

  /* S2. healthy -> a SUBPAGE times out: the audit is still honest and complete, but the subpage's old issues are NOT "resolved" */
  {
    const w = await makeWorld(store, 's2');
    const a = await audit(store, w);
    const about = await aboutPage(store, w);
    const ia = await issues(store, w, a.audit);
    w.st.about = 'hang';
    const b = await audit(store, w, { env: { SEO_REQUEST_TIMEOUT_MS: '600' } });
    const ib = await issues(store, w, b.audit), aboutNow = await aboutPage(store, w);
    const gone = [...keys(ia)].filter((k) => !keys(ib).has(k));
    const cmp = (await viaRouter(b.audit.id)).audit.comparison;
    ok(T('S2. setup: the first audit really found issues on /about, and the second audit really did not observe it (failed fetch, recorded by audit B)'), ia.some((i) => i.page_id === about.id && i.type === 'title-length') && aboutNow.status_code === null && aboutNow.last_audit_id === b.audit.id, JSON.stringify([aboutNow.status_code, aboutNow.last_audit_id, b.audit.id]));
    ok(T('S2. the start page WAS observed, so the audit is a normal complete audit with a score (a failed subpage never fails the audit)'), !b.hung && b.audit.status === 'complete' && typeof b.audit.score === 'number' && b.audit.errors_count >= 1, JSON.stringify([b.audit.status, b.audit.score, b.audit.errors_count]));
    ok(T('S2. the only issues that vanished are /about\'s own — the ones that used to be counted "resolved"'), gone.length >= 1 && gone.every((k) => k.endsWith(`:${about.id}`)), gone.join());
    ok(T('S2. …and they are NOT counted resolved: resolved 0, they are reported as not rechecked, everything else unchanged'), cmp.resolvedCount === 0 && cmp.introducedCount === 0 && cmp.notRecheckedCount === gone.length && cmp.unchangedCount === keys(ia).size - gone.length, JSON.stringify({ cmp, gone: gone.length }));
  }

  /* S3. healthy -> the START page is completely unreachable: a FAILED audit, nothing recorded, no comparison presented */
  let healthyAudit, failedAudit, worldS3;
  {
    const w = worldS3 = await makeWorld(store, 's3');
    const a = healthyAudit = await audit(store, w);
    const pagesBefore = JSON.stringify(await store.listPages(w.site.id));
    const b = failedAudit = await audit(store, w, { base: await closedBase() });
    const ib = await issues(store, w, b.audit);
    const shown = (await viaRouter(b.audit.id)).audit;
    ok(T('S3. start page unreachable: the audit FAILED (the existing status), it did not complete, and it did not hang'), !b.hung && b.audit.status === 'failed' && b.audit.finished_at != null, JSON.stringify([b.audit.status, b.hung]));
    ok(T('S3. …no misleading score is stored'), b.audit.score === null);
    ok(T('S3. …the summary says plainly that the start page could not be observed, and why (no trailing period: the UI appends one)'), /^The start page http:\/\/127\.0\.0\.1:\d+\/ could not be observed \(.+\), so no results were recorded for this scan$/.test(b.audit.summary), b.audit.summary);
    ok(T('S3. …the crawl\'s real counts are recorded (1 page attempted, 1 error)'), b.audit.pages_crawled === 1 && b.audit.errors_count === 1, JSON.stringify([b.audit.pages_crawled, b.audit.errors_count]));
    ok(T('S3. …nothing from the crawl was recorded: no issues, and the page rows are exactly as the healthy audit left them'), ib.length === 0 && JSON.stringify(await store.listPages(w.site.id)) === pagesBefore);
    ok(T('S3. …read through the real router the failed audit carries NO comparison and NO issue count (nothing false is presented as a result)'), shown.status === 'failed' && !('comparison' in shown) && !('issueCount' in shown) && shown.score === null, JSON.stringify(shown).slice(0, 200));
    ok(T('S3. …and the healthy audit is still the latest COMPLETE one, its own data untouched'), (await store.previousCompleteAudit(w.site.id, b.audit.id)).id === a.audit.id && (await issues(store, w, a.audit)).length > 0);
  }

  /* S5. failed -> healthy: the failed audit is never the baseline */
  {
    const w = worldS3;
    const c = await audit(store, w);
    const ia = await issues(store, w, healthyAudit.audit), cmp = (await viaRouter(c.audit.id)).audit.comparison;
    ok(T('S5. a healthy audit after a failed one compares against the last genuinely COMPLETE audit, not the failed one'), c.audit.status === 'complete' && cmp && cmp.previousAuditId === healthyAudit.audit.id && cmp.previousAuditId !== failedAudit.audit.id, JSON.stringify(cmp));
    ok(T('S5. …with honest numbers: nothing changed, nothing resolved or introduced'), cmp.resolvedCount === 0 && cmp.introducedCount === 0 && cmp.unchangedCount === keys(ia).size && cmp.notRecheckedCount === 0 && c.audit.score === healthyAudit.audit.score, JSON.stringify(cmp));
  }

  /* S4. start page HTTP error that WAS fetched stays a normal audit; one that is not an HTML response is unobserved */
  {
    const w = await makeWorld(store, 's4');
    const a = await audit(store, w);
    w.st.home = '503-html';
    const b = await audit(store, w);
    const ib = await issues(store, w, b.audit), home = (await store.listPages(w.site.id)).find((p) => p.url === w.base);
    ok(T('S4. start page returns HTTP 503 (an HTML response): the response WAS observed, so the audit stays complete — it is not "unreachable"'), !b.hung && b.audit.status === 'complete' && typeof b.audit.score === 'number' && home.status_code === 503 && home.last_audit_id === b.audit.id, JSON.stringify([b.audit.status, home.status_code]));
    ok(T('S4. …the broken-page issue is kept for the start page, and the score reflects it'), ib.some((i) => i.type === 'broken-page' && i.severity === 'critical' && i.page_id === home.id) && b.audit.score < a.audit.score, JSON.stringify([a.audit.score, b.audit.score]));

    const w2 = await makeWorld(store, 's4b');
    await audit(store, w2); w2.st.home = '503-text';
    const t = await audit(store, w2);
    ok(T('S4. start page 503 as plain text is NOT an HTML response the analyzer can represent: unobserved -> a failed audit that says so (existing crawler semantics preserved)'), t.audit.status === 'failed' && t.audit.score === null && /not an HTML page — HTTP 503, text\/plain/.test(t.audit.summary), t.audit.summary);
    const w3 = await makeWorld(store, 's4c');
    await audit(store, w3); w3.st.home = 'json';
    const j = await audit(store, w3);
    ok(T('S4. start page that answers 200 with JSON (not HTML) is unobserved too -> failed, no score'), j.audit.status === 'failed' && j.audit.score === null && /not an HTML page — HTTP 200, application\/json/.test(j.audit.summary), j.audit.summary);
  }

  /* S6. a page observed in both audits: its fixed issue IS resolved */
  {
    const w = await makeWorld(store, 's6');
    const a = await audit(store, w);
    const ia = await issues(store, w, a.audit);
    w.st.about = 'fixed';
    const b = await audit(store, w);
    const ib = await issues(store, w, b.audit), about = await aboutPage(store, w);
    const fixed = [...keys(ia)].filter((k) => !keys(ib).has(k));
    const cmp = (await viaRouter(b.audit.id)).audit.comparison;
    ok(T('S6. setup: /about was observed by the second audit (200, HTML, this audit) and its short-title issue is gone'), about.status_code === 200 && about.last_audit_id === b.audit.id && ia.some((i) => i.type === 'title-length' && i.page_id === about.id) && !ib.some((i) => i.type === 'title-length'), JSON.stringify([about.status_code, about.last_audit_id]));
    ok(T('S6. a fixed issue on an observed page IS counted as resolved'), fixed.length >= 1 && cmp.resolvedCount === fixed.length && cmp.notRecheckedCount === 0 && cmp.introducedCount === 0, JSON.stringify({ cmp, fixed: fixed.length }));
  }

  /* S7. a page the new audit never observed: its issue is NOT resolved — however it came to be unobserved */
  for (const sc of [
    ['no longer linked from anywhere (never reached)', (st) => { st.homeLinksAbout = false; }, {}],
    ['excluded by robots.txt', (st) => { st.robotsAboutBlocked = true; }, {}],
    ['stopped short by the page limit', () => {}, { SEO_MAX_PAGES: '1' }],
  ]) {
    const w = await makeWorld(store, 's7');
    const a = await audit(store, w);
    const ia = await issues(store, w, a.audit);
    sc[1](w.st);
    const b = await audit(store, w, { env: sc[2] });
    const ib = await issues(store, w, b.audit), about = await aboutPage(store, w);
    const gone = [...keys(ia)].filter((k) => !keys(ib).has(k));
    const cmp = (await viaRouter(b.audit.id)).audit.comparison;
    ok(T(`S7. ${sc[0]}: /about was not observed (its row still belongs to the older audit) and its issues vanished from the new audit`), b.audit.status === 'complete' && about.last_audit_id === a.audit.id && gone.length >= 1 && gone.every((k) => k.endsWith(`:${about.id}`)), JSON.stringify([b.audit.status, about.last_audit_id, a.audit.id, gone]));
    ok(T(`S7. ${sc[0]}: …so they are NOT counted resolved (resolved 0, ${gone.length} not rechecked)`), cmp.resolvedCount === 0 && cmp.notRecheckedCount === gone.length, JSON.stringify(cmp));
  }

  /* S8. page-less (site-wide) issues keep their ordinary comparison — the guard never touches them */
  {
    const w = await makeWorld(store, 's8a');
    w.st.robots = 'missing';
    const a = await audit(store, w);
    const ia = await issues(store, w, a.audit);
    const global = ia.find((i) => i.type === 'missing-robots-txt');
    w.st.robots = 'allow';
    const b = await audit(store, w);
    const cmp = (await viaRouter(b.audit.id)).audit.comparison;
    ok(T('S8. a site-wide issue (missing robots.txt, no page) that was fixed IS counted resolved, exactly as before'), global && global.page_id === null && cmp.resolvedCount === 1 && cmp.introducedCount === 0 && cmp.notRecheckedCount === 0 && cmp.unchangedCount === keys(ia).size - 1, JSON.stringify({ cmp, global: !!global }));

    const w2 = await makeWorld(store, 's8b');
    w2.st.robots = 'missing';
    const a2 = await audit(store, w2); const ia2 = await issues(store, w2, a2.audit);
    const b2 = await audit(store, w2);
    const cmp2 = (await viaRouter(b2.audit.id)).audit.comparison;
    ok(T('S8. a site-wide issue that persists stays "unchanged" (it is not filtered out of the comparison)'), cmp2.resolvedCount === 0 && cmp2.unchangedCount === keys(ia2).size && cmp2.notRecheckedCount === 0, JSON.stringify(cmp2));

    const w3 = await makeWorld(store, 's8c');
    w3.st.robots = 'missing';
    const a3 = await audit(store, w3); const ia3 = await issues(store, w3, a3.audit);
    w3.st.robots = 'allow'; w3.st.about = 'hang';
    const b3 = await audit(store, w3, { env: { SEO_REQUEST_TIMEOUT_MS: '600' } });
    const ib3 = await issues(store, w3, b3.audit), about3 = await aboutPage(store, w3);
    const goneAbout = [...keys(ia3)].filter((k) => !keys(ib3).has(k) && k.endsWith(`:${about3.id}`));
    const cmp3 = (await viaRouter(b3.audit.id)).audit.comparison;
    ok(T('S8. both at once: the fixed site-wide issue is resolved (1) while the unobserved page\'s issues are not rechecked — the two rules do not interfere'), cmp3.resolvedCount === 1 && cmp3.notRecheckedCount === goneAbout.length && goneAbout.length >= 1, JSON.stringify({ cmp3, goneAbout: goneAbout.length }));
  }

  /* S9. a start page robots.txt excludes is still a normal audit with its critical finding */
  {
    const w = await makeWorld(store, 's9');
    await audit(store, w);
    w.st.robots = 'disallow-all';
    const b = await audit(store, w);
    const ib = await issues(store, w, b.audit);
    ok(T('S9. start page excluded by robots.txt: a complete audit that reports the critical robots-disallow issue (it is represented, not unobserved)'), b.audit.status === 'complete' && typeof b.audit.score === 'number' && ib.some((i) => i.type === 'robots-disallow' && i.severity === 'critical'), JSON.stringify([b.audit.status, ib.map((i) => i.type)]));
  }

  /* S10. a page that is still broken (or becomes broken) is never mis-reported */
  {
    const w = await makeWorld(store, 's10a');
    w.st.about = '404-html';
    const a = await audit(store, w); const ia = await issues(store, w, a.audit);
    const b = await audit(store, w);
    const cmp = (await viaRouter(b.audit.id)).audit.comparison;
    ok(T('S10. a page that stays broken (404 HTML in both audits) is "unchanged" — never "introduced" or "not rechecked"'), ia.some((i) => i.type === 'broken-page') && cmp.unchangedCount === keys(ia).size && cmp.introducedCount === 0 && cmp.resolvedCount === 0 && cmp.notRecheckedCount === 0, JSON.stringify(cmp));

    const w2 = await makeWorld(store, 's10b');
    const a2 = await audit(store, w2); const ia2 = await issues(store, w2, a2.audit);
    w2.st.about = '404-html';
    const b2 = await audit(store, w2);
    const ib2 = await issues(store, w2, b2.audit);
    const cmp2 = (await viaRouter(b2.audit.id)).audit.comparison;
    ok(T('S10. a page that BREAKS (200 -> 404 HTML): its old title issue is not called resolved (a 404 is not a successful observation), the broken-page issue is new'), ia2.some((i) => i.type === 'title-length') && !ib2.some((i) => i.type === 'title-length') && ib2.some((i) => i.type === 'broken-page') && cmp2.resolvedCount === 0 && cmp2.notRecheckedCount >= 1 && cmp2.introducedCount >= 1, JSON.stringify(cmp2));
  }

  await new Promise((r) => api.server.close(r));
}

/* ═════════ Part 2: store-level matrix for the comparison (hand-built audits, page rows and issues) ═════════ */
async function matrix(label, store) {
  const T = (n) => `[${label}] ${n}`;
  const site = await store.ensureWebsite(`matrix-${label}.test`, `matrix-${label}`);
  const other = await store.ensureWebsite(`matrix-other-${label}.test`, 'other');
  const done = async (siteId, status = 'complete') => { const a = await store.createAudit(siteId, { baseUrl: 'https://matrix.test/', pagesPlanned: 10, status: 'running' }); await store.finishAudit(a.id, { score: status === 'complete' ? 80 : null, status, summary: status, pagesCrawled: 1, errorsCount: 0, durationMs: 1 }); return a; };
  const P = await done(site.id), C = await done(site.id);
  const seed = (siteId, name, { auditId, status, type }) => store.upsertPage({ websiteId: siteId, url: `https://matrix.test/${name}`, finalUrl: `https://matrix.test/${name}`, statusCode: status, contentType: type, auditId });
  const html = 'text/html';
  const specs = [
    ['ok-200', { auditId: C.id, status: 200, type: html }, true],
    ['ok-299', { auditId: C.id, status: 299, type: html }, true],
    ['ok-charset', { auditId: C.id, status: 200, type: 'text/html; charset=utf-8' }, true],
    ['older-audit', { auditId: P.id, status: 200, type: html }, false],
    ['http-404', { auditId: C.id, status: 404, type: html }, false],
    ['http-301', { auditId: C.id, status: 301, type: html }, false],
    ['json', { auditId: C.id, status: 200, type: 'application/json' }, false],
    ['no-content-type', { auditId: C.id, status: 200, type: null }, false],
    ['failed-fetch', { auditId: C.id, status: null, type: null }, false],
  ];
  const rows = [];
  for (const [name, o, resolves] of specs) rows.push({ name, resolves, pageId: await seed(site.id, name, o) });
  const foreign = await seed(other.id, 'foreign', { auditId: C.id, status: 200, type: html });
  const issueRows = [
    ...rows.map((r) => ({ pageId: r.pageId, type: 'title-length', severity: 'warning', detail: r.name })),
    { pageId: foreign, type: 'title-length', severity: 'warning', detail: 'foreign website\'s page' },
    { pageId: 987654, type: 'title-length', severity: 'warning', detail: 'page row that does not exist' },
    { pageId: null, type: 'missing-sitemap', severity: 'critical', detail: 'site-wide' },
  ];
  await store.createIssues(site.id, P.id, issueRows);   // the previous audit found one issue per page; the current audit found none
  const cmp = await compareToPreviousAudit(store, site.id, C.id);
  const expectedResolved = rows.filter((r) => r.resolves).length + 1;                 // + the site-wide issue
  ok(T('M1. matrix: only issues on pages this audit observed as a successful HTML response (200 and 299, with or without a charset) — and the site-wide issue — are resolved'), cmp.resolvedCount === expectedResolved, JSON.stringify(cmp));
  ok(T('M2. matrix: every other page-level issue is "not rechecked": older audit, HTTP 404, HTTP 301, non-HTML, no content type, failed fetch, another website\'s page, a missing page row'), cmp.notRecheckedCount === issueRows.length - expectedResolved && cmp.unchangedCount === 0 && cmp.introducedCount === 0, JSON.stringify(cmp));
  ok(T('M3. the comparison response keeps its original fields and adds one'), Object.keys(cmp).sort().join() === 'introducedCount,notRecheckedCount,previousAuditId,resolvedCount,unchangedCount' && cmp.previousAuditId === P.id);

  // issues that ARE reported again are unchanged / introduced whatever the page's status — the filter only governs "resolved"
  const site2 = await store.ensureWebsite(`matrix2-${label}.test`, 'matrix2');
  const P2 = await done(site2.id), C2 = await done(site2.id);
  const broken = await seed(site2.id, 'broken', { auditId: C2.id, status: 503, type: html });
  await store.createIssues(site2.id, P2.id, [{ pageId: broken, type: 'broken-page', severity: 'critical', detail: 'was broken' }, { pageId: broken, type: 'title-length', severity: 'warning', detail: 'old' }]);
  await store.createIssues(site2.id, C2.id, [{ pageId: broken, type: 'broken-page', severity: 'critical', detail: 'still broken' }, { pageId: broken, type: 'missing-h1', severity: 'critical', detail: 'new, on the unobserved page' }]);
  const cmp2 = await compareToPreviousAudit(store, site2.id, C2.id);
  ok(T('M4. a still-reported issue on a non-successful page is "unchanged"; a new one is "introduced"; only the vanished one is "not rechecked"'), cmp2.unchangedCount === 1 && cmp2.introducedCount === 1 && cmp2.resolvedCount === 0 && cmp2.notRecheckedCount === 1, JSON.stringify(cmp2));

  // the baseline: a failed audit is never selected, even when it is newer
  const site3 = await store.ensureWebsite(`matrix3-${label}.test`, 'matrix3');
  const first = await done(site3.id), failed = await done(site3.id, 'failed'), latest = await done(site3.id);
  ok(T('M5. a newer FAILED audit is never the baseline: the previous complete audit is the earlier genuine one'), (await store.previousCompleteAudit(site3.id, latest.id)).id === first.id && (await compareToPreviousAudit(store, site3.id, latest.id)).previousAuditId === first.id && failed.id > first.id);
  const site4 = await store.ensureWebsite(`matrix4-${label}.test`, 'matrix4');
  await done(site4.id, 'failed'); const only = await done(site4.id);
  ok(T('M5. with only a failed audit before it there is no baseline at all (null), not a comparison against the failure'), (await compareToPreviousAudit(store, site4.id, only.id)) === null);
}

/* ═════════ run both backends ═════════ */
const sqlite = await createStore();
const { Pool } = newDb().adapters.createPg();
const pg = await createStore({ pool: new Pool() });
ok('the second backend really is the PostgreSQL adapter (pg-mem)', pg.kind === 'postgres' && sqlite.kind.startsWith('sqlite'));
for (const [label, store] of [['sqlite', sqlite], ['pg-mem', pg]]) {
  await endToEnd(label, store);
  await matrix(label, store);
}

/* ═════════ Part 4: wiring, from source ═════════ */
{
  const jobs = src('./seo/jobs.js');
  const code = jobs.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
  const exec = code.slice(code.indexOf('export async function executeScan'), code.indexOf('export async function ensureProgressing'));
  const cmpSrc = code.slice(code.indexOf('export async function compareToPreviousAudit'), code.indexOf('const observedByAudit'));
  ok('W1. executeScan decides the start page BEFORE it analyzes anything or writes any page, link or issue row', exec.indexOf('startPageProblem(crawl)') > 0 && exec.indexOf('startPageProblem(crawl)') < exec.indexOf('analyzePages(crawl)') && exec.indexOf('startPageProblem(crawl)') < exec.indexOf('store.upsertPage(') && exec.indexOf('startPageProblem(crawl)') < exec.indexOf('store.createIssues('));
  ok('W2. the failure goes through the one existing failure path: a throw into the existing catch — finishAudit is still called exactly twice and no new audit status exists', /throw Object\.assign\(/.test(exec) && (code.match(/store\.finishAudit\(/g) || []).length === 2 && (code.match(/status: '[a-z]+'/g) || []).sort().join() === "status: 'complete',status: 'failed'" && !/status: 'unobserved'|status: 'partial'|status: 'unreachable'/.test(code));
  ok('W3. the start-page rule: robots-excluded counts as observed; an error, a missing status or a non-HTML response does not; an HTTP error status alone never fails the audit', /if \(start\.disallowedByRobots\) return null;/.test(code) && /if \(start\.error\) return/.test(code) && /if \(start\.statusCode == null\) return/.test(code) && /text\\\/html\/i\.test\(start\.contentType/.test(code) && !/statusCode >= 400|statusCode < 200|statusCode >= 500|res\.ok/.test(code.slice(code.indexOf('const startPageProblem'), code.indexOf('export async function executeScan'))));
  ok('W4. the comparison reuses the Hardening #5 predicate (observedByAudit) — no second, incompatible definition — and only for issues that have a page', /observedByAudit\(pageById\.get\(i\.page_id\), websiteId, currentAuditId\)/.test(cmpSrc) && /i\.page_id != null/.test(cmpSrc) && (code.match(/const observedByAudit/g) || []).length === 1);
  ok('W5. only the "resolved" bucket is filtered: introduced and unchanged are computed exactly as before', /introducedCount: \[\.\.\.currKeys\]\.filter\(\(k\) => !prevKeys\.has\(k\)\)\.length,/.test(cmpSrc) && /unchangedCount: \[\.\.\.currKeys\]\.filter\(\(k\) => prevKeys\.has\(k\)\)\.length,/.test(cmpSrc) && /resolvedCount: \[\.\.\.prevKeys\]\.filter\(\(k\) => !currKeys\.has\(k\) && !notRechecked\.has\(k\)\)\.length,/.test(cmpSrc));
  ok('W6. scope: no schema or page-persistence change (db.js has no honesty-related code), no frontend change, verification semantics untouched', !/notRechecked|startPage/.test(src('./db.js')) && !/notRechecked/.test(src('./admin/admin.js')) && /const observedByAudit = \(page, websiteId, auditId\) => !!page/.test(jobs) && /page\.last_audit_id === auditId/.test(jobs));
}

for (const s of sockets) s.destroy();
for (const s of servers) s.close();
await sqlite.close(); await pg.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.on('exit', () => { for (const s of ['', '-wal', '-shm']) { try { rmSync(DB + s, { force: true }); } catch { /* temp file, harmless */ } } });
setTimeout(() => process.exit(fail ? 1 : 0), 300);
