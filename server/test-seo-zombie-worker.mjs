// Phase 4 Hardening #8 — a worker that lost its audit must not corrupt newer crawl state.
// Before: after audit A was recovered as stale and audit B completed, worker A could resume and (1) overwrite B's page rows through
// upsertPage() — title, description, status, content type, AND last_audit_id moving backwards from B to A — which silently skipped B's
// recommendation verification (Hardening #5), understated B's comparison (Hardening #7) and fed regressed rows to the specialists, and
// (2) write issue/link rows into an audit that was already over. Now:
//   * upsertPage() refuses, in the UPDATE itself, to write a page that a strictly NEWER audit of the same website already owns
//     (and still returns the existing page id), so no interleaving of two writers can move a page backwards;
//   * a first-time INSERT that loses a race for a new URL falls into the same guarded update instead of failing the audit;
//   * executeScan() checks, right after the crawl, that its audit is still running — if not it records nothing and runs no
//     post-audit step. That check is not the boundary (a recovery can still land just after it); the SQL guard is.
// SQLite (including two independent connections to one file) and pg-mem (the PostgreSQL adapter) both run Parts 1-4. pg-mem and SQLite
// interleave async requests in one process: they prove the SQL and the interleavings they can produce, NOT real PostgreSQL concurrency.
// Run: node server/test-seo-zombie-worker.mjs
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { newDb } from 'pg-mem';

const DB = join(tmpdir(), 'hk-zombie-worker-test.db');
for (const s of ['', '-wal', '-shm']) rmSync(DB + s, { force: true });
Object.assign(process.env, { SQLITE_PATH: DB, SMTP_HOST: '', SETUP_TOKEN: '', GOOGLE_CLIENT_ID: '', NODE_ENV: 'development', SEO_CRAWL_DELAY_MS: '1', SEO_REQUEST_TIMEOUT_MS: '30000', SEO_MAX_PAGES: '10' });
for (const k of ['DATABASE_URL', 'PAGESPEED_API_KEY', 'ANTHROPIC_API_KEY', 'SEO_MAX_DEPTH', 'SEO_STALE_AUDIT_MS']) delete process.env[k];

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { (cond ? pass++ : fail++); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };
const watchdog = setTimeout(() => { console.log('FAIL  watchdog: the test did not finish in time'); process.exit(1); }, 170_000);
watchdog.unref();

const { createStore } = await import(new URL('./db.js', import.meta.url).href);
const { executeScan, compareToPreviousAudit } = await import(new URL('./seo/jobs.js', import.meta.url).href);
const src = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const yieldOnce = () => new Promise((r) => setImmediate(r));
const until = async (fn, ms = 10_000) => { const t = Date.now(); while (!(await fn())) { if (Date.now() - t > ms) throw new Error('timed out waiting'); await sleep(15); } };
const mulberry32 = (a) => () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const captureErrors = async (lines, fn) => { const orig = console.error; console.error = (...a) => lines.push(a.join(' ')); try { return await fn(); } finally { console.error = orig; } };

const sockets = new Set(), servers = [];
const listen = async (handler) => {
  const server = http.createServer(handler);
  server.on('connection', (s) => sockets.add(s));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return { host: `127.0.0.1:${server.address().port}`, base: `http://127.0.0.1:${server.address().port}/` };
};

/* ───────────── the two backends ───────────── */
async function sqliteBackend() {
  const store = await createStore();
  const store2 = await createStore();                       // a second, independent connection to the SAME file — a second server instance
  const raw = new DatabaseSync(DB); raw.exec('PRAGMA busy_timeout = 5000');
  return { label: 'sqlite', store, store2, count: async (table, col, id) => Number(raw.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = ?`).get(id).n), close: async () => { raw.close(); await store2.close(); await store.close(); } };
}
async function pgMemBackend() {
  const { Pool } = newDb().adapters.createPg(); const pool = new Pool();
  const store = await createStore({ pool });
  return { label: 'pg-mem', store, store2: null, count: async (table, col, id) => Number((await pool.query(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = $1`, [id])).rows[0].n), close: async () => { await store.close(); } };
}

/* ═════════ Part 1: the page write itself ═════════ */
async function pageLevel(b) {
  const { store, store2, label } = b;
  const T = (n) => `[${label}] ${n}`;
  const site = await store.ensureWebsite(`zombie-${label}.test`, `zombie-${label}`);
  const other = await store.ensureWebsite(`zombie-other-${label}.test`, 'other');
  const newAudit = (siteId = site.id) => store.createAudit(siteId, { baseUrl: 'https://zombie.test/', pagesPlanned: 10, status: 'running' });
  const A = await newAudit();
  await store.failStaleAudits(site.id, { cutoff: new Date(Date.now() + 60_000).toISOString(), summary: 'recovered as stale' });   // A is recovered first, as in production: the database allows ONE active audit per website
  const B = await newAudit(), otherAudit = await newAudit(other.id);                                 // ids only grow: A < B < otherAudit
  ok(T('S0. setup: audit ids only grow, so a recovered audit is always older than the one that replaced it'), A.id < B.id && B.id < otherAudit.id);
  const w = (s, u, o) => s.upsertPage({ websiteId: site.id, url: u, finalUrl: u, ...o });
  const get = async (u) => (await store.listPages(site.id)).filter((p) => p.url === u);
  const url = (n) => `https://zombie.test/${label}/${n}`;
  const B_VALUES = { title: 'B title', description: 'B description', statusCode: 200, contentType: 'text/html', canonical: 'https://zombie.test/b', h1Count: 1, wordCount: 120 };
  const A_VALUES = { title: 'A title', description: 'A description', statusCode: 500, contentType: 'text/plain', canonical: 'https://zombie.test/a', h1Count: 7, wordCount: 3 };

  // 1. the critical case: an OLDER audit cannot overwrite a page a NEWER audit owns
  { const u = url('t1');
    const idB = await w(store, u, { ...B_VALUES, auditId: B.id }); const before = (await get(u))[0]; await sleep(5);
    const idA = await w(store, u, { ...A_VALUES, auditId: A.id }); const rows = await get(u), after = rows[0];
    ok(T('1. the older audit does NOT overwrite the newer audit\'s page: title, description, status, content type, canonical, counts all remain B\'s'), rows.length === 1 && after.title === 'B title' && after.description === 'B description' && after.status_code === 200 && after.content_type === 'text/html' && after.canonical === 'https://zombie.test/b' && after.h1_count === 1 && after.word_count === 120, JSON.stringify(after));
    ok(T('1. …last_audit_id does not move backwards (still B) and not even the timestamps changed — nothing was written at all'), after.last_audit_id === B.id && after.updated_at === before.updated_at && after.last_crawled_at === before.last_crawled_at, JSON.stringify([after.last_audit_id, before.updated_at, after.updated_at]));
    ok(T('1. …and the loser still gets the existing page id back, so the crawl code downstream keeps working'), Number.isInteger(idA) && idA === idB && idA === after.id, JSON.stringify([idA, idB]));
  }
  // 2. the same audit may rewrite its own page
  { const u = url('t2');
    const id1 = await w(store, u, { ...B_VALUES, auditId: B.id }); const id2 = await w(store, u, { ...B_VALUES, title: 'B title, second crawl', auditId: B.id }); const after = (await get(u))[0];
    ok(T('2. the same audit can rewrite its own page: updated, last_audit_id stays B, same page id'), after.title === 'B title, second crawl' && after.last_audit_id === B.id && id1 === id2 && id2 === after.id, JSON.stringify(after));
  }
  // 3. a newer audit replaces an older audit's page
  { const u = url('t3');
    const idA = await w(store, u, { ...A_VALUES, auditId: A.id }); const idB = await w(store, u, { ...B_VALUES, auditId: B.id }); const after = (await get(u))[0];
    ok(T('3. a newer audit replaces an older audit\'s page: B\'s values win and last_audit_id becomes B'), after.title === 'B title' && after.status_code === 200 && after.content_type === 'text/html' && after.last_audit_id === B.id && idA === idB, JSON.stringify(after));
  }
  // 4. first insertion
  { const u = url('t4');
    const id = await w(store, u, { ...A_VALUES, statusCode: 200, contentType: 'text/html', auditId: A.id }); const rows = await get(u);
    ok(T('4. a new page is inserted once, with the writer\'s values and last_audit_id, and its id is returned'), rows.length === 1 && rows[0].id === id && rows[0].title === 'A title' && rows[0].last_audit_id === A.id && rows[0].website_id === site.id, JSON.stringify(rows));
  }
  // 5. what counts as "owned by a newer audit": only a real, newer audit of THIS website
  { const uNull = url('t5-null'), uUnknown = url('t5-unknown'), uForeign = url('t5-foreign');
    await w(store, uNull, { ...B_VALUES });                                                  // a legacy row: no owner at all
    await w(store, uUnknown, { ...B_VALUES, auditId: 987654321 });                           // an owner id that is no audit at all
    await w(store, uForeign, { ...B_VALUES, auditId: otherAudit.id });                       // a NEWER id, but an audit of ANOTHER website
    for (const u of [uNull, uUnknown, uForeign]) await w(store, u, { ...A_VALUES, auditId: A.id });
    const [n, un, f] = [(await get(uNull))[0], (await get(uUnknown))[0], (await get(uForeign))[0]];
    ok(T('5. a legacy row (no last_audit_id), an unknown audit id, and another website\'s newer audit id never block a write — only a real newer audit of this website does'), [n, un, f].every((p) => p.title === 'A title' && p.last_audit_id === A.id), JSON.stringify([n.last_audit_id, un.last_audit_id, f.last_audit_id]));
  }
  // 6. callers that name no audit keep their old, unconditional behaviour (no production caller exists: executeScan always passes its audit)
  { const u = url('t6');
    await w(store, u, { ...B_VALUES, auditId: B.id }); await w(store, u, { title: 'Plain store write', description: 'no audit involved' });
    const after = (await get(u))[0];
    ok(T('6. a write that names no audit is unconditional exactly as before (it replaces the row, and last_audit_id becomes empty)'), after.title === 'Plain store write' && after.last_audit_id === null, JSON.stringify(after));
  }

  // 7. concurrency: an older and a newer audit write the same page at the same moment, in many interleavings
  const writers = [['one connection', store, store]];
  if (store2) writers.push(['two independent connections to one file', store, store2]);
  for (const [what, sNewer, sOlder] of writers) {
    let errors = 0, wrongOwner = 0, wrongValues = 0, wrongId = 0, trials = 0;
    for (let trial = 0; trial < 60; trial++) {
      const rand = mulberry32(7000 + trial), u = url(`race-${what.length}-${trial}`), mode = trial % 3;   // 0 = new URL, 1 = page owned by the older audit, 2 = page already owned by the newer one
      if (mode === 1) await w(store, u, { ...A_VALUES, statusCode: 200, auditId: A.id });
      if (mode === 2) await w(store, u, { ...B_VALUES, auditId: B.id });
      const delay = async (n) => { for (let i = 0; i < n; i++) await yieldOnce(); };
      const [dOld, dNew] = [Math.floor(rand() * 7), Math.floor(rand() * 7)];
      const older = (async () => { await delay(dOld); return w(sOlder, u, { ...A_VALUES, statusCode: 200, auditId: A.id }); })();
      const newer = (async () => { await delay(dNew); return w(sNewer, u, { ...B_VALUES, auditId: B.id }); })();
      const [rOld, rNew] = await Promise.allSettled([older, newer]);
      trials++;
      if (rOld.status !== 'fulfilled' || rNew.status !== 'fulfilled') { errors++; continue; }
      const rows = await get(u);
      if (rows.length !== 1 || rows[0].last_audit_id !== B.id) wrongOwner++;
      if (rows[0].title !== 'B title') wrongValues++;
      if (rOld.value !== rows[0].id || rNew.value !== rows[0].id) wrongId++;
    }
    console.log(`      ${label}: ${trials} concurrent older/newer writers on ${what} -> errors ${errors}, newer audit did not own the page ${wrongOwner}, wrong values ${wrongValues}, wrong page id ${wrongId}`);
    ok(T(`7. ${what}: ${trials} interleavings of an older and a newer audit writing one page (new URL, owned by the older audit, owned by the newer one) — the newer audit ALWAYS ends up owning it, with its own values`), trials === 60 && wrongOwner === 0 && wrongValues === 0, JSON.stringify({ errors, wrongOwner, wrongValues }));
    ok(T(`7. ${what}: …no writer ever failed (a lost race for a NEW url no longer throws a unique violation) and both got the single page's id`), errors === 0 && wrongId === 0, JSON.stringify({ errors, wrongId }));
  }

  // 7b. the lost insert race, FORCED: both writers are started in the same tick, so both read "no such page" before either inserts and one
  //     insert hits the unique constraint (SQLite and pg-mem alike). Nobody may fail, and the newer audit must own the page whichever order they start in.
  for (const [what, sNewer, sOlder] of writers) {
    for (const order of ['older first', 'newer first']) {
      let bad = 0;
      for (let i = 0; i < 10; i++) {
        const u = url(`forced-${what.length}-${order[0]}-${i}`);
        const older = () => w(sOlder, u, { ...A_VALUES, statusCode: 200, auditId: A.id }), newer = () => w(sNewer, u, { ...B_VALUES, auditId: B.id });
        const settled = await Promise.allSettled(order === 'older first' ? [older(), newer()] : [newer(), older()]);
        const rows = await get(u);
        if (settled.some((r) => r.status !== 'fulfilled') || rows.length !== 1 || rows[0].last_audit_id !== B.id || rows[0].title !== 'B title' || settled.some((r) => r.value !== rows[0].id)) bad++;
      }
      ok(T(`7b. ${what}, ${order}: 10 forced lost insert races on a NEW page — no writer fails, one page row, the newer audit owns it with its own values, both writers get its id`), bad === 0, `${bad} of 10 went wrong`);
    }
  }
}

/* ═════════ Parts 2-4: the real executeScan() lifecycle (A recovered, B completes, A resumes) ═════════ */
const FIXED = 'A Properly Sized Home Page Title Here';
const html = (t, h1, links) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${t}</title><meta name="description" content="A description that is comfortably longer than the fifty character minimum for this page."><meta name="viewport" content="width=device-width"><link rel="canonical" href="http://x/"><script type="application/ld+json">{"@context":"https://schema.org","@type":"WebPage"}</script></head><body><h1>${h1}</h1><p>${Array.from({ length: 70 }, (_, i) => h1 + i).join(' ')}</p>${links}</body></html>`;
const POST_AUDIT = ['listUnverifiedApplied', 'setRecommendationVerification', 'listPages', 'createRecommendation', 'setSpecialistDiagnostics', 'findLatestSpecialistRecommendation'];
const WRITES = ['upsertPage', 'createLinks', 'createIssues'];

/** The store, recording every method the worker calls; `fakeRunning` makes getAudit() report the audit as still running — i.e. a recovery
 *  that lands just AFTER the worker's ownership check, the window a check can never close. */
const spyStore = (store, calls, { fakeRunning = false } = {}) => new Proxy(store, { get(t, p) {
  const v = t[p]; if (typeof v !== 'function') return v;
  return async (...a) => { calls.push(String(p)); const r = await v.apply(t, a); return fakeRunning && p === 'getAudit' && r ? { ...r, status: 'running' } : r; };
} });

async function lifecycle(b, { label: kind, bypassCheck }) {
  const { store, label, count } = b;
  const T = (n) => `[${label}] ${kind}: ${n}`;
  const st = { title: 'Short', park: false, parked: false };
  let release; const gate = new Promise((r) => { release = r; });
  const w = await listen(async (req, res) => {
    const send = (c, t, x) => { res.writeHead(c, { 'content-type': t }); res.end(x); };
    if (req.url === '/robots.txt') return send(200, 'text/plain', 'User-agent: *\nAllow: /\n');
    if (req.url === '/sitemap.xml') return send(404, 'text/plain', 'no');
    if (req.url === '/') return send(200, 'text/html', html(st.title, 'Home', '<a href="/about">About</a>'));
    if (req.url === '/about') { if (st.park) { st.park = false; st.parked = true; await gate; } return send(200, 'text/html', html('About this site and its team here', 'About', '<a href="/">Home</a>')); }
    send(404, 'text/plain', 'no');
  });
  const site = await store.ensureWebsite(w.host, `zombie-lifecycle-${label}-${kind}`);
  const mk = () => store.createAuditIfNoneActive(site.id, { baseUrl: w.base, pagesPlanned: 10 });
  const homeRow = async () => (await store.listPages(site.id)).find((p) => p.url === w.base);
  const aboutRow = async () => (await store.listPages(site.id)).find((p) => p.url === `${w.base}about`);

  // P: a first healthy audit finds a short title on home; a recommendation to fix it is then applied
  const P = await mk(); await executeScan(store, site.id, P.id, w.base);
  const home0 = await homeRow();
  const pIssue = (await store.listIssues({ websiteId: site.id, auditId: P.id })).find((i) => i.type === 'title-length' && i.page_id === home0.id);
  const rec = await store.createRecommendation({ websiteId: site.id, issueId: pIssue.id, pageId: home0.id, type: 'title', currentValue: 'Short', proposedValue: FIXED, reasoning: 'r', aiProvider: 'anthropic', aiModel: 'm' });
  await store.setRecommendationStatus(rec.id, 'approved', { reviewedBy: 'a@x.test' }); await store.setRecommendationStatus(rec.id, 'applied', { applied: true });
  await sleep(25);

  // A starts, reads the OLD home page, and is parked mid-crawl; it is then recovered as stale, the site is fixed, and B starts
  const logs = [], aCalls = [];
  st.park = true;
  const A = await mk();
  const runA = captureErrors(logs, () => executeScan(spyStore(store, aCalls, { fakeRunning: bypassCheck }), site.id, A.id, w.base).then(() => 'returned', (e) => 'THREW ' + e.message));
  await until(() => st.parked);
  const recovered = await store.failStaleAudits(site.id, { cutoff: new Date(Date.now() + 60_000).toISOString(), summary: 'recovered as stale (test)' });
  const recoveredRow = await store.getAudit(A.id);
  st.title = FIXED;
  const B = await mk();
  // B crawls and writes; right before B finishes, zombie A is released and gets to finish ITS crawl and (if it writes anything) its writes first
  const bListPages = []; let released = false, bIssuesBefore = null;
  const bStore = new Proxy(store, { get(t, p) {
    const v = t[p]; if (typeof v !== 'function') return v;
    if (p === 'finishAudit') return async (id, o) => { if (id === B.id && !released) { released = true; bIssuesBefore = (await t.listIssues({ websiteId: site.id, auditId: B.id, limit: 5000 })).length; release(); await runA; } return v.apply(t, [id, o]); };
    if (p === 'listPages') return async (...a) => { const r = await v.apply(t, a); bListPages.push(r.find((x) => x.url === w.base)); return r; };
    return v.bind(t);
  } });
  await captureErrors(logs, () => executeScan(bStore, site.id, B.id, w.base));
  const zombieResult = await runA;

  const [aRow, bRow, home, about, recNow, cmp] = [await store.getAudit(A.id), await store.getAudit(B.id), await homeRow(), await aboutRow(), await store.getRecommendation(rec.id), await compareToPreviousAudit(store, site.id, B.id)];
  ok(T('setup: A was recovered while its worker was alive, and B was allowed to start (the exact lifecycle from the audit)'), recovered === 1 && recoveredRow.status === 'failed' && B.id > A.id && released && bIssuesBefore > 0, JSON.stringify([recovered, recoveredRow.status, A.id, B.id, released, bIssuesBefore]));
  ok(T('the zombie worker returns normally (losing the race is not an error)'), zombieResult === 'returned', String(zombieResult));
  ok(T('A stays failed, with the recovery text and the recovery time — the zombie did not touch its own audit row either'), aRow.status === 'failed' && aRow.summary === 'recovered as stale (test)' && aRow.finished_at === recoveredRow.finished_at && aRow.score === null && aRow.specialist_diagnostics === null, JSON.stringify(aRow).slice(0, 200));
  ok(T('B completes with a score'), bRow.status === 'complete' && typeof bRow.score === 'number', JSON.stringify([bRow.status, bRow.score]));
  ok(T('THE INVARIANT: the page B established still holds B\'s values after the zombie resumed — fixed title, status 200, HTML, last_audit_id = B (never A)'), home.title === FIXED && home.status_code === 200 && home.content_type === 'text/html' && home.last_audit_id === B.id && about.last_audit_id === B.id, JSON.stringify([home.title, home.status_code, home.content_type, home.last_audit_id, about.last_audit_id, A.id, B.id]));
  ok(T('B\'s recommendation verification is correct: the applied fix B really observed is recorded "resolved" BY B (not skipped as "unobserved")'), recNow.verified_status === 'resolved' && recNow.verified_audit_id === B.id && recNow.status === 'applied', JSON.stringify([recNow.verified_status, recNow.verified_audit_id]));
  ok(T('B\'s comparison is stable and exact: the fixed issue is resolved (1), nothing is "not rechecked"'), cmp.resolvedCount === 1 && cmp.notRecheckedCount === 0 && cmp.introducedCount === 0 && cmp.previousAuditId === P.id, JSON.stringify(cmp));
  const seen = bListPages[0];
  ok(T('B\'s specialist integration read B\'s page state, not the zombie\'s (home: fixed title, last_audit_id = B)'), bListPages.length >= 1 && seen && seen.title === FIXED && seen.last_audit_id === B.id, JSON.stringify(seen && [seen.title, seen.last_audit_id]));
  ok(T('the zombie\'s loss is logged'), logs.some((l) => new RegExp(`audit #${A.id} was already recovered as stale`).test(l)), logs.join(' | ').slice(0, 300));
  const postAudit = POST_AUDIT.filter((m) => aCalls.includes(m)), wrote = WRITES.filter((m) => aCalls.includes(m));
  ok(T('the zombie never ran verification, specialist integration, recommendation creation or diagnostics persistence'), postAudit.length === 0, postAudit.join());
  if (!bypassCheck) {
    ok(T('the ownership check stopped the worker before any write: no page, link or issue call at all, no finishAudit, nothing recorded under A'), wrote.length === 0 && !aCalls.includes('finishAudit') && (await store.listIssues({ websiteId: site.id, auditId: A.id })).length === 0 && (await count('page_links', 'audit_id', A.id)) === 0, JSON.stringify([aCalls, wrote]));
  } else {
    ok(T('with the ownership check bypassed (recovery landing just after it) the worker really DID attempt its writes — and the page guard alone kept B\'s data intact (see the invariant above)'), wrote.includes('upsertPage') && aCalls.includes('finishAudit'), JSON.stringify(aCalls));
    const aIssues = await store.listIssues({ websiteId: site.id, auditId: A.id });
    const bIssuesAfter = await store.listIssues({ websiteId: site.id, auditId: B.id, limit: 5000 });
    ok(T('…any issue/link rows that worker managed to write carry audit A\'s id (audit-scoped history of a failed audit); B\'s own issue rows are exactly as B left them'), aIssues.every((i) => i.audit_id === A.id) && bIssuesAfter.length === bIssuesBefore && bIssuesAfter.every((i) => i.audit_id === B.id), JSON.stringify([aIssues.length, bIssuesBefore, bIssuesAfter.length]));
  }

  // a later healthy audit is unaffected by anything the zombie did
  await sleep(10);
  const C = await mk(); await executeScan(store, site.id, C.id, w.base);
  const cRow = await store.getAudit(C.id), cCmp = await compareToPreviousAudit(store, site.id, C.id);
  ok(T('the next audit completes normally and uses B (not the failed zombie) as its baseline'), cRow.status === 'complete' && cCmp.previousAuditId === B.id && cCmp.resolvedCount === 0 && cCmp.introducedCount === 0 && cCmp.notRecheckedCount === 0, JSON.stringify(cCmp));
  return { site, w };
}

/** Control: the same spy on a HEALTHY worker sees every call the zombie must not make — so "zero calls" above is meaningful. */
async function control(b) {
  const { store, label } = b;
  const w = await listen((req, res) => {
    const send = (c, t, x) => { res.writeHead(c, { 'content-type': t }); res.end(x); };
    if (req.url === '/robots.txt') return send(200, 'text/plain', 'User-agent: *\nAllow: /\n');
    if (req.url === '/') return send(200, 'text/html', html('Short', 'Home', '<a href="/about">About</a>'));
    if (req.url === '/about') return send(200, 'text/html', html('About this site and its team here', 'About', '<a href="/">Home</a>'));
    send(404, 'text/plain', 'no');
  });
  const site = await store.ensureWebsite(w.host, `zombie-control-${label}`);
  const a = await store.createAuditIfNoneActive(site.id, { baseUrl: w.base, pagesPlanned: 10 });
  const calls = [];
  await executeScan(spyStore(store, calls), site.id, a.id, w.base);
  ok(`[${label}] control: a healthy worker's store DOES see the write calls, the finish, verification and specialist calls (so the zombie's zero is meaningful)`, WRITES.every((m) => calls.includes(m)) && calls.includes('finishAudit') && POST_AUDIT.filter((m) => ['listUnverifiedApplied', 'listPages'].includes(m)).every((m) => calls.includes(m)), calls.join());
}

/* ═════════ run ═════════ */
const sqlite = await sqliteBackend(), pg = await pgMemBackend();
ok('the second backend really is the PostgreSQL adapter (pg-mem)', pg.store.kind === 'postgres' && sqlite.store.kind.startsWith('sqlite'));
for (const b of [sqlite, pg]) {
  await pageLevel(b);
  await control(b);
  await lifecycle(b, { label: 'real executeScan, ownership check active', bypassCheck: false });
  await lifecycle(b, { label: 'real executeScan, ownership check BYPASSED (the SQL guard alone)', bypassCheck: true });
}

/* ═════════ Part 5: wiring, from source ═════════ */
{
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
  const dbSrc = strip(src('./db.js')), jobs = strip(src('./seo/jobs.js'));
  const up = dbSrc.slice(dbSrc.indexOf('async upsertPage'), dbSrc.indexOf('async listPages'));
  const exec = jobs.slice(jobs.indexOf('export async function executeScan'), jobs.indexOf('export async function ensureProgressing'));
  ok('W1. the ownership condition is IN the UPDATE statement: refuse only when a strictly newer audit OF THIS WEBSITE owns the row; an empty owner always passes', /WHERE id=\? AND \(last_audit_id IS NULL OR NOT \(last_audit_id > \? AND last_audit_id IN \(SELECT id FROM seo_audits WHERE website_id = \?\)\)\)/.test(up));
  ok('W2. the guarded UPDATE is the only update path that carries an audit id; a write with no audit id keeps the plain unconditional UPDATE', /if \(auditId == null\) await db\.run\(`UPDATE pages SET \$\{SET\} WHERE id=\?`/.test(up) && (up.match(/UPDATE pages SET/g) || []).length === 2);
  ok('W3. a lost insert race falls into the same guarded update (unique violation on both engines), and any other error is thrown', /err\?\.code === '23505' \|\| \/UNIQUE constraint failed\/i\.test\(String\(err\?\.message\)\)/.test(up) && /existing = await find\(\);/.test(up) && /\) throw err;/.test(up));
  ok('W4. the page id is returned whether or not the write won (callers keep working)', /return Number\(existing\.id\);/.test(up));
  ok('W5. executeScan checks ownership right after the crawl — before it decides the start page, analyzes, or writes anything — and returns without finishing or post-audit work', exec.indexOf('store.getAudit(auditId)') > 0 && exec.indexOf('store.getAudit(auditId)') < exec.indexOf('startPageProblem(crawl)') && exec.indexOf('store.getAudit(auditId)') < exec.indexOf('store.upsertPage(') && /owned\.status !== 'running'\)\s*\{[\s\S]*?return;/.test(exec));
  ok('W6. the one production caller of upsertPage always names its audit', (jobs.match(/store\.upsertPage\(/g) || []).length === 1 && /jsonLdPresent: p\.jsonLdPresent, auditId,/.test(jobs));
  // (Hardening #9 deliberately added the one partial unique index on seo_audits; this scope proof now allows exactly that one and nothing more.)
  ok('W7. scope: no new column, no unique index other than the one-active-audit index, no transaction or lock code, finishAudit still called exactly twice, no new audit status', (dbSrc.match(/ADD COLUMN/g) || []).length === 2 && (dbSrc.match(/CREATE UNIQUE INDEX/g) || []).length === 1 && /CREATE UNIQUE INDEX IF NOT EXISTS \$\{ACTIVE_AUDIT_INDEX\} ON seo_audits \(website_id\)/.test(dbSrc) && !/BEGIN|COMMIT|ROLLBACK|FOR UPDATE|pg_advisory/i.test(dbSrc) && (jobs.match(/store\.finishAudit\(/g) || []).length === 2 && !/status: 'zombie'|status: 'stale'/.test(jobs));
}

for (const s of sockets) s.destroy();
for (const s of servers) s.close();
await sqlite.close(); await pg.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.on('exit', () => { for (const s of ['', '-wal', '-shm']) { try { rmSync(DB + s, { force: true }); } catch { /* temp file, harmless */ } } });
setTimeout(() => process.exit(fail ? 1 : 0), 300);
