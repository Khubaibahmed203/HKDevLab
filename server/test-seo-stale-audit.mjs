// Phase 4 Hardening #1 — stale SEO audit recovery + guarded terminal audit transitions.
// An audit stuck 'queued'/'running' (process killed, restarted or timed out before finishAudit()) used to block every
// later scan of its website forever. queueScan() now fails that website's stale audits in one atomic UPDATE before
// createAuditIfNoneActive(), and finishAudit() can only leave a non-terminal state — so a worker that was still
// crawling when its audit got recovered can neither overwrite it nor run any post-audit work against it.
// Run: node server/test-seo-stale-audit.mjs
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { newDb } from 'pg-mem';

const DB = join(tmpdir(), 'hk-seo-stale-audit-test.db');
for (const s of ['', '-wal', '-shm']) rmSync(DB + s, { force: true });
Object.assign(process.env, { SQLITE_PATH: DB, SMTP_HOST: '', SETUP_TOKEN: '', GOOGLE_CLIENT_ID: '', NODE_ENV: 'development' });
for (const k of ['DATABASE_URL', 'PAGESPEED_API_KEY', 'SEO_STALE_AUDIT_MS', 'SEO_MAX_PAGES', 'SEO_MAX_DEPTH', 'SEO_REQUEST_TIMEOUT_MS', 'SEO_CRAWL_DELAY_MS']) delete process.env[k];

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { (cond ? pass++ : fail++); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };

const { createStore } = await import(new URL('./db.js', import.meta.url).href);
const { queueScan, executeScan, STALE_AUDIT_SUMMARY } = await import(new URL('./seo/jobs.js', import.meta.url).href);
const { staleAuditMs, crawlLimits } = await import(new URL('./seo/limits.js', import.meta.url).href);
const src = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const store = await createStore();
const raw = new DatabaseSync(DB);   // second connection, used only to backdate started_at (the store API deliberately can't)
raw.exec('PRAGMA busy_timeout = 5000');
const MIN = 60_000;
const backdate = (id, minutes) => raw.prepare('UPDATE seo_audits SET started_at = ? WHERE id = ?').run(new Date(Date.now() - minutes * MIN).toISOString(), id);
const cutoff30 = () => new Date(Date.now() - 30 * MIN).toISOString();
const futureCutoff = () => new Date(Date.now() + MIN).toISOString();   // "everything active is older than this" — recovers every active audit of the website
const baseUrl = 'http://127.0.0.1:9';
const newAudit = (websiteId, status) => store.createAudit(websiteId, { baseUrl, pagesPlanned: 5, status });
const captureErrors = async (fn) => {
  const lines = [], orig = console.error;
  console.error = (...a) => lines.push(a.join(' '));
  try { await fn(); } finally { console.error = orig; }
  return lines;
};

/* ───────────── A. stale sweep (store level) — items 1-11 ───────────── */
{
  // A website can have only ONE queued/running audit (Hardening #9: the database refuses a second), so each active audit below lives on its own
  // website, and the sweep — which is per website — is run once per website with the same cutoff.
  const site = await store.ensureWebsite('stale-a.test', 'A');
  const siteQ = await store.ensureWebsite('stale-a-queued.test', 'AQ');
  const siteFreshR = await store.ensureWebsite('stale-a-fresh-running.test', 'AFR');
  const siteFreshQ = await store.ensureWebsite('stale-a-fresh-queued.test', 'AFQ');
  const other = await store.ensureWebsite('stale-b.test', 'B');
  const doneOld = await newAudit(site.id, 'running');
  await store.finishAudit(doneOld.id, { score: 91, status: 'complete', summary: 'real result', pagesCrawled: 3, errorsCount: 0, durationMs: 10 }); backdate(doneOld.id, 120);
  const failedOld = await newAudit(site.id, 'running');
  await store.finishAudit(failedOld.id, { score: null, status: 'failed', summary: 'a real crawl error' }); backdate(failedOld.id, 120);
  const staleRunning = await newAudit(site.id, 'running'); backdate(staleRunning.id, 31);
  const staleQueued = await newAudit(siteQ.id, 'queued'); backdate(staleQueued.id, 31);
  const freshRunning = await newAudit(siteFreshR.id, 'running');
  const freshQueued = await newAudit(siteFreshQ.id, 'queued');
  const otherStale = await newAudit(other.id, 'running'); backdate(otherStale.id, 31);
  const before = Date.now();
  const doneBefore = await store.getAudit(doneOld.id), failedBefore = await store.getAudit(failedOld.id);

  const n = await store.failStaleAudits(site.id, { cutoff: cutoff30(), summary: STALE_AUDIT_SUMMARY });
  ok('5. only the requested website is affected (another website\'s stale audits, queued or running, are untouched)', (await store.getAudit(otherStale.id)).status === 'running' && (await store.getAudit(staleQueued.id)).status === 'queued');
  const nq = await store.failStaleAudits(siteQ.id, { cutoff: cutoff30(), summary: STALE_AUDIT_SUMMARY });
  const nFresh = (await store.failStaleAudits(siteFreshR.id, { cutoff: cutoff30(), summary: STALE_AUDIT_SUMMARY })) + (await store.failStaleAudits(siteFreshQ.id, { cutoff: cutoff30(), summary: STALE_AUDIT_SUMMARY }));
  ok('recovers exactly the stale active audit of each website (one running, one queued), reports the count, and finds nothing on the websites whose audit is fresh', n === 1 && nq === 1 && nFresh === 0, JSON.stringify([n, nq, nFresh]));
  ok('1. a fresh running audit is NOT recovered', (await store.getAudit(freshRunning.id)).status === 'running');
  ok('2. a fresh queued audit is NOT recovered', (await store.getAudit(freshQueued.id)).status === 'queued');
  const sr = await store.getAudit(staleRunning.id), sq = await store.getAudit(staleQueued.id);
  ok('3. a stale running audit becomes failed', sr.status === 'failed');
  ok('4. a stale queued audit becomes failed', sq.status === 'failed');
  ok('6. an existing complete audit is untouched, even though it is old', JSON.stringify(await store.getAudit(doneOld.id)) === JSON.stringify(doneBefore));
  ok('7. an existing failed audit is untouched (its real error is not replaced)', JSON.stringify(await store.getAudit(failedOld.id)) === JSON.stringify(failedBefore) && failedBefore.summary === 'a real crawl error');
  ok('8. recovery is idempotent — a second sweep changes nothing', (await store.failStaleAudits(site.id, { cutoff: cutoff30(), summary: STALE_AUDIT_SUMMARY })) === 0);
  ok('9. finished_at is populated on every recovered audit (a valid ISO time, not before the sweep began)', [sr, sq].every((a) => typeof a.finished_at === 'string' && Date.parse(a.finished_at) >= before - 1000));
  ok('10. the summary is the fixed stale-recovery text', sr.summary === STALE_AUDIT_SUMMARY && sq.summary === STALE_AUDIT_SUMMARY && /stale-audit recovery/i.test(sr.summary));
  ok('recovery leaves score and duration alone (null — nothing was ever recorded)', sr.score === null && sr.duration_ms === null && sq.score === null);

  const edge = await store.ensureWebsite('stale-edge.test', 'Edge');
  const e = await newAudit(edge.id, 'running');
  const S = (await store.getAudit(e.id)).started_at;
  ok('11. cutoff boundary: started_at exactly equal to the cutoff is NOT stale (strict "<")', (await store.failStaleAudits(edge.id, { cutoff: S, summary: STALE_AUDIT_SUMMARY })) === 0 && (await store.getAudit(e.id)).status === 'running');
  ok('11. …and one millisecond older than the cutoff IS stale', (await store.failStaleAudits(edge.id, { cutoff: new Date(Date.parse(S) + 1).toISOString(), summary: STALE_AUDIT_SUMMARY })) === 1 && (await store.getAudit(e.id)).status === 'failed');
}

/* ───────────── B. queue behavior (queueScan) — items 12-14 ───────────── */
{
  // claimAudit() is stubbed to lose, so the background executeScan() the queue kicks off is a harmless no-op —
  // these tests are about the queue decision, not about crawling
  const noCrawl = { ...store, claimAudit: async () => false };
  const site = (name) => store.ensureWebsite(`${name}.test`, name);

  const wStaleQueued = await site('queue-stale-queued');
  const staleQ = await newAudit(wStaleQueued.id, 'queued'); backdate(staleQ.id, 31);
  let created; const logs12 = await captureErrors(async () => { created = await queueScan(noCrawl, wStaleQueued, { baseUrl }); });
  ok('12. a stale QUEUED audit no longer blocks a new scan — queueScan() creates a fresh queued audit', !!created && created.status === 'queued' && created.id !== staleQ.id);
  ok('12. …and the stale one was failed with the recovery summary', (await store.getAudit(staleQ.id)).status === 'failed' && (await store.getAudit(staleQ.id)).summary === STALE_AUDIT_SUMMARY);
  ok('12. …and the recovery is logged', logs12.some((l) => /recovered 1 stale audit/.test(l)), logs12.join(' | '));

  const wStaleRunning = await site('queue-stale-running');
  const staleR = await newAudit(wStaleRunning.id, 'running'); backdate(staleR.id, 31);
  await captureErrors(async () => { created = await queueScan(noCrawl, wStaleRunning, { baseUrl }); });
  ok('12. a stale RUNNING audit no longer blocks a new scan either', !!created && created.id !== staleR.id && (await store.getAudit(staleR.id)).status === 'failed');

  const wFresh = await site('queue-fresh');
  const fresh = await newAudit(wFresh.id, 'running');
  ok('13. a fresh active audit still blocks: queueScan() returns null (the route turns that into the existing 409)', (await queueScan(noCrawl, wFresh, { baseUrl })) === null);
  ok('13. …and the fresh audit is left exactly as it was', (await store.getAudit(fresh.id)).status === 'running');

  const brokenSweep = { ...noCrawl, failStaleAudits: async () => { throw new Error('simulated sweep failure'); } };
  const wBroken = await site('queue-sweep-broken');
  const stuck = await newAudit(wBroken.id, 'queued'); backdate(stuck.id, 31);
  let blocked; const logs14 = await captureErrors(async () => { blocked = await queueScan(brokenSweep, wBroken, { baseUrl }); });
  ok('14. when the sweep itself fails, the stale audit still blocks as before: queueScan() returns null (409), never a second active audit', blocked === null && (await store.listAudits(wBroken.id)).length === 1);
  ok('14. …the failure is logged, and the audit is left untouched', logs14.some((l) => /stale-audit recovery failed/.test(l) && /simulated sweep failure/.test(l)) && (await store.getAudit(stuck.id)).status === 'queued');
  const wClean = await site('queue-sweep-broken-clean');
  let normal; await captureErrors(async () => { normal = await queueScan(brokenSweep, wClean, { baseUrl }); });
  ok('14. a failing sweep never stops an ordinary scan with nothing active from being queued', !!normal && normal.status === 'queued');
}

/* ───────────── C. guarded finish (store level) — items 15-20 ───────────── */
{
  const site = await store.ensureWebsite('guard.test', 'Guard');
  const finish = (id, status, extra = {}) => store.finishAudit(id, { score: status === 'complete' ? 88 : null, status, summary: status === 'complete' ? 'ok' : 'a real error', pagesCrawled: 1, errorsCount: 0, durationMs: 5, ...extra });

  const q = await newAudit(site.id, 'queued');
  ok('15. queued -> complete works and reports true', (await finish(q.id, 'complete')) === true && (await store.getAudit(q.id)).status === 'complete' && (await store.getAudit(q.id)).score === 88);
  const r = await newAudit(site.id, 'running');
  ok('16. running -> complete works and reports true (score, summary and finished_at recorded)', (await finish(r.id, 'complete')) === true && (await store.getAudit(r.id)).status === 'complete' && (await store.getAudit(r.id)).summary === 'ok' && !!(await store.getAudit(r.id)).finished_at);
  const q2 = await newAudit(site.id, 'queued');
  ok('17. queued -> failed works and reports true', (await finish(q2.id, 'failed')) === true && (await store.getAudit(q2.id)).status === 'failed');
  const r2 = await newAudit(site.id, 'running');   // only after q2 is over: a website can have one active audit at a time
  ok('17. running -> failed works and reports true, keeping the real error text', (await finish(r2.id, 'failed')) === true && (await store.getAudit(r2.id)).summary === 'a real error');

  const done = await store.getAudit(r.id);
  ok('18. finishing an already-complete audit again reports false and changes nothing', (await finish(r.id, 'failed', { summary: 'late' })) === false && JSON.stringify(await store.getAudit(r.id)) === JSON.stringify(done));
  ok('18. finishing an already-failed audit reports false and changes nothing', (await finish(r2.id, 'complete')) === false && (await store.getAudit(r2.id)).status === 'failed' && (await store.getAudit(r2.id)).score === null);

  const zombieSite = await store.ensureWebsite('guard-zombie.test', 'Zombie');
  const z = await newAudit(zombieSite.id, 'running');
  await store.failStaleAudits(zombieSite.id, { cutoff: futureCutoff(), summary: STALE_AUDIT_SUMMARY });
  const recovered = await store.getAudit(z.id);
  ok('19. a zombie worker\'s late SUCCESS cannot overwrite the recovered audit (reports false; row unchanged)', (await finish(z.id, 'complete')) === false && JSON.stringify(await store.getAudit(z.id)) === JSON.stringify(recovered));
  ok('19. a zombie worker\'s late FAILURE cannot overwrite the recovery summary either', (await finish(z.id, 'failed', { summary: 'worker error after recovery' })) === false && (await store.getAudit(z.id)).summary === STALE_AUDIT_SUMMARY);
  ok('19. …the recovered row is still failed, with no score, and finished_at was not moved', recovered.status === 'failed' && recovered.score === null && (await store.getAudit(z.id)).finished_at === recovered.finished_at);

  const raceSite = await store.ensureWebsite('guard-race.test', 'Race');
  let sweepWon = 0, finishWon = 0, bad = [];
  for (let i = 0; i < 40; i++) {
    const a = await newAudit(raceSite.id, 'running');
    const sweep = () => store.failStaleAudits(raceSite.id, { cutoff: futureCutoff(), summary: STALE_AUDIT_SUMMARY });
    const fin = () => finish(a.id, 'complete');
    // Alternating which statement is issued first exercises both outcomes (the SQLite driver runs each statement
    // synchronously when called) — what matters is the invariant: exactly one of the two atomic UPDATEs wins
    const [x, y] = i % 2 ? await Promise.all([sweep(), fin()]) : (await Promise.all([fin(), sweep()])).reverse();
    const row = await store.getAudit(a.id);
    const swept = x === 1, finished = y === true;
    if (swept === finished) bad.push(`#${i}: both or neither won (${x}, ${y})`);
    else if (finished && !(row.status === 'complete' && row.score === 88 && row.summary === 'ok')) bad.push(`#${i}: finish won but row is ${row.status}/${row.summary}`);
    else if (swept && !(row.status === 'failed' && row.score === null && row.summary === STALE_AUDIT_SUMMARY)) bad.push(`#${i}: sweep won but row is ${row.status}/${row.summary}`);
    swept ? sweepWon++ : finishWon++;
  }
  ok('20. recovery vs finish: in 40 rounds exactly one atomic UPDATE won every time, and the row is never a mix of the two', bad.length === 0, bad.join('; '));
  ok('20. …and both outcomes (sweep first, finish first) were actually exercised', sweepWon > 0 && finishWon > 0, `${sweepWon}/${finishWon}`);
}

/* ───────────── D. post-audit safety with REAL executeScan() runs — item 21 (+ real-path versions of 17/19) ───────────── */
{
  const longTitle = 'This Is An Extremely Long And Overly Descriptive Page Title That Definitely Exceeds Sixty Characters By Quite A Lot';
  let gate = null;
  const makeGate = () => { let arrive, release; const arrived = new Promise((r) => (arrive = r)); const released = new Promise((r) => (release = r)); return { arrive, release, arrived, released }; };
  const httpServer = createServer(async (req, res) => {
    // The applied recommendation seeded by seedWebsite() is about /old-page. Verification only speaks for a page the verifying
    // audit actually observed, so the live site serves that page too (linked from the home page) and the real crawl fetches it.
    if (req.url === '/old-page') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<html lang="en"><head><title>This Old Page Now Has A Perfectly Sized Title</title><meta name="viewport" content="width=device-width"><meta name="description" content="A perfectly adequate description that comfortably clears the length threshold the analyzer checks for."><link rel="canonical" href="/old-page"></head><body><h1>Old page</h1><p>${'word '.repeat(80)}</p></body></html>`);
      return;
    }
    if (req.url !== '/') { res.writeHead(404); res.end(); return; }
    const g = gate;
    if (g) { g.arrive(); await g.released; }   // hold the page response so the crawl is genuinely mid-flight while we recover the audit
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<html lang="en"><head><title>${longTitle}</title><meta name="viewport" content="width=device-width"><meta name="description" content="A perfectly adequate description that comfortably clears the length threshold the analyzer checks for."><link rel="canonical" href="/"><script type="application/ld+json">{"@context":"https://schema.org","@type":"WebSite"}</script></head><body><h1>Hello</h1><a href="/old-page">old page</a><p>${'word '.repeat(80)}</p></body></html>`);
  });
  await new Promise((resolve) => httpServer.listen(0, resolve));
  const live = `http://127.0.0.1:${httpServer.address().port}`;

  /** A website with one already-APPLIED recommendation whose originating issue is not in any later scan — so a
   *  scan that reaches verification records a verified_status for it, and one that doesn't leaves it null. */
  async function seedWebsite(name) {
    const site = await store.ensureWebsite(`${name}.test`, name);
    const prior = await store.createAudit(site.id, { baseUrl: live, pagesPlanned: 5, status: 'running' });
    const pageId = await store.upsertPage({ websiteId: site.id, url: `${live}/old-page`, finalUrl: `${live}/old-page`, statusCode: 200, title: 'Old', description: 'Old', auditId: prior.id });
    await store.createIssues(site.id, prior.id, [{ pageId, type: 'title-length', severity: 'warning', detail: 'x' }]);
    await store.finishAudit(prior.id, { score: 80, status: 'complete', summary: 'prior', pagesCrawled: 1, errorsCount: 0, durationMs: 5 });
    const issue = (await store.listIssues({ websiteId: site.id, auditId: prior.id }))[0];
    const rec = await store.createRecommendation({ websiteId: site.id, issueId: issue.id, pageId, type: 'title', currentValue: 'x', proposedValue: 'y', reasoning: 'z', aiProvider: 'anthropic', aiModel: 'm' });
    await store.setRecommendationStatus(rec.id, 'approved', { reviewedBy: 'tester' });
    await store.setRecommendationStatus(rec.id, 'applied', { applied: true });
    await new Promise((r) => setTimeout(r, 15));   // the scan under test must start strictly AFTER the fix was applied, or verification skips it by design
    return { site, recId: rec.id };
  }
  const specialistRecs = async (site) => (await store.listRecommendations({ websiteId: site.id })).filter((r) => r.ai_provider === 'specialist-agent').length;

  // control: a healthy, un-recovered scan — proves the post-audit steps below genuinely run when the worker still owns its audit
  const control = await seedWebsite('d-control');
  const cAudit = await store.createAudit(control.site.id, { baseUrl: live, pagesPlanned: 5, status: 'queued' });
  await executeScan(store, control.site.id, cAudit.id, live);
  const cDone = await store.getAudit(cAudit.id), cRec = await store.getRecommendation(control.recId);
  ok('A (control). a healthy scan finishes complete', cDone.status === 'complete' && typeof cDone.score === 'number');
  ok('21 (control). …and DID run recommendation verification (the applied recommendation got a verified_status)', cRec.verified_status === 'resolved', String(cRec.verified_status));
  ok('21 (control). …and DID run specialist integration (a pending title recommendation was created) and persist diagnostics', (await specialistRecs(control.site)) >= 1 && cDone.specialist_diagnostics !== null);

  // zombie: the audit is recovered while the worker is still crawling
  const zombie = await seedWebsite('d-zombie');
  const zAudit = await store.createAudit(zombie.site.id, { baseUrl: live, pagesPlanned: 5, status: 'queued' });
  gate = makeGate();
  const run = executeScan(store, zombie.site.id, zAudit.id, live);
  await gate.arrived;
  ok('zombie setup: the worker claimed the audit and is mid-crawl', (await store.getAudit(zAudit.id)).status === 'running');
  ok('zombie setup: stale recovery fails it while that worker is still running', (await store.failStaleAudits(zombie.site.id, { cutoff: futureCutoff(), summary: STALE_AUDIT_SUMMARY })) === 1);
  const recoveredRow = await store.getAudit(zAudit.id);
  let threw = false;
  const zLogs = await captureErrors(async () => { gate.release(); gate = null; try { await run; } catch { threw = true; } });
  const zAfter = await store.getAudit(zAudit.id), zRec = await store.getRecommendation(zombie.recId);
  ok('the zombie worker\'s executeScan() returns normally — losing the race is not an error', !threw);
  ok('19 (real path). the zombie worker did NOT overwrite the recovered audit — still failed, summary and finished_at unchanged, no score', zAfter.status === 'failed' && zAfter.summary === STALE_AUDIT_SUMMARY && zAfter.finished_at === recoveredRow.finished_at && zAfter.score === null && zAfter.pages_crawled === null);
  ok('21. the zombie did NOT run recommendation verification (the applied recommendation still has no verified_status)', zRec.verified_status === null, String(zRec.verified_status));
  ok('21. the zombie did NOT run specialist integration (no specialist recommendation was created)', (await specialistRecs(zombie.site)) === 0);
  ok('21. the zombie did NOT persist diagnostics for the audit it no longer owns', zAfter.specialist_diagnostics === null);
  ok('21. losing the race is logged', zLogs.some((l) => new RegExp(`audit #${zAudit.id} was already recovered as stale`).test(l)), zLogs.join(' | '));
  // (Hardening #8 changed this one: a worker that lost its audit used to leave its own crawl data behind; it now stops before writing any.)
  ok('no cleanup, and no new crawl data: the prior audit\'s page and issue are untouched, and the zombie recorded no page or issue of its own', (await store.listPages(zombie.site.id)).length === 1 && (await store.listPages(zombie.site.id))[0].url === `${live}/old-page` && (await store.listPages(zombie.site.id))[0].title === 'Old' && (await store.listIssues({ websiteId: zombie.site.id })).length === 1 && (await store.listIssues({ websiteId: zombie.site.id, auditId: zAudit.id })).length === 0);

  // failure path: the worker throws AFTER its audit was recovered. An ownership check now stops a recovered worker before it writes anything,
  // so this models the one window a check can never close — recovery lands just AFTER the check, so the worker still sees 'running', carries
  // on writing, and then fails.
  const boom = { ...store, createIssues: async () => { throw new Error('simulated persistence failure'); } };
  const justAfterCheck = { ...boom, getAudit: async (id) => { const row = await store.getAudit(id); return row && { ...row, status: 'running' }; } };
  const ff = await seedWebsite('d-fail-recovered');
  const ffAudit = await store.createAudit(ff.site.id, { baseUrl: live, pagesPlanned: 5, status: 'queued' });
  gate = makeGate();
  const ffRun = executeScan(justAfterCheck, ff.site.id, ffAudit.id, live);
  await gate.arrived;
  await store.failStaleAudits(ff.site.id, { cutoff: futureCutoff(), summary: STALE_AUDIT_SUMMARY });
  const ffRecovered = await store.getAudit(ffAudit.id);
  let ffThrew = false;
  const ffLogs = await captureErrors(async () => { gate.release(); gate = null; try { await ffRun; } catch { ffThrew = true; } });
  const ffAfter = await store.getAudit(ffAudit.id);
  ok('7/19 (real path). a worker that FAILS after its audit was recovered does not overwrite it (summary stays the recovery text) and does not throw', !ffThrew && ffAfter.status === 'failed' && ffAfter.summary === STALE_AUDIT_SUMMARY && ffAfter.finished_at === ffRecovered.finished_at);
  ok('7. …it logs that the audit had already been moved on, and makes no second terminal attempt', ffLogs.some((l) => /had already been moved out of queued\/running/.test(l)));

  // failure path, nothing recovered: unchanged behavior
  const fn = await seedWebsite('d-fail-normal');
  const fnAudit = await store.createAudit(fn.site.id, { baseUrl: live, pagesPlanned: 5, status: 'queued' });
  await executeScan(boom, fn.site.id, fnAudit.id, live);
  const fnAfter = await store.getAudit(fnAudit.id);
  ok('17 (real path). a normal worker failure still records failed with the real error text', fnAfter.status === 'failed' && fnAfter.summary === 'simulated persistence failure' && !!fnAfter.finished_at);

  httpServer.close();
}

/* ───────────── E. the same SQL on the PostgreSQL adapter (pg-mem) ───────────── */
{
  const pool = new (newDb().adapters.createPg().Pool)();
  const pg = await createStore({ pool });
  // one active audit per website (Hardening #9), so the fresh, stale-running and stale-queued audits each get their own website, swept one by one
  const site = await pg.ensureWebsite('pg-stale.test', 'PG'), siteQ = await pg.ensureWebsite('pg-stale-queued.test', 'PGQ'), siteF = await pg.ensureWebsite('pg-stale-fresh.test', 'PGF');
  const backdatePg = (id, minutes) => pool.query('UPDATE seo_audits SET started_at = $1 WHERE id = $2', [new Date(Date.now() - minutes * MIN).toISOString(), id]);
  const mk = (s, status) => pg.createAudit(s.id, { baseUrl, pagesPlanned: 5, status });
  const done = await mk(site, 'running');
  await pg.finishAudit(done.id, { score: 70, status: 'complete', summary: 'ok', pagesCrawled: 1, errorsCount: 0, durationMs: 5 }); await backdatePg(done.id, 90);
  const fresh = await mk(siteF, 'running'), staleR = await mk(site, 'running'), staleQ = await mk(siteQ, 'queued');
  await backdatePg(staleR.id, 31); await backdatePg(staleQ.id, 31);
  const sweepAll = async () => (await pg.failStaleAudits(site.id, { cutoff: cutoff30(), summary: STALE_AUDIT_SUMMARY })) + (await pg.failStaleAudits(siteQ.id, { cutoff: cutoff30(), summary: STALE_AUDIT_SUMMARY })) + (await pg.failStaleAudits(siteF.id, { cutoff: cutoff30(), summary: STALE_AUDIT_SUMMARY }));
  ok('pg-mem: the sweep recovers exactly the two stale active audits', (await sweepAll()) === 2);
  ok('pg-mem: fresh and complete audits are untouched; stale ones are failed with finished_at and the summary', (await pg.getAudit(fresh.id)).status === 'running' && (await pg.getAudit(done.id)).status === 'complete' && (await pg.getAudit(staleR.id)).status === 'failed' && !!(await pg.getAudit(staleQ.id)).finished_at && (await pg.getAudit(staleQ.id)).summary === STALE_AUDIT_SUMMARY);
  ok('pg-mem: a second sweep is idempotent', (await sweepAll()) === 0);
  ok('pg-mem: finishAudit() on a recovered audit reports false and changes nothing; on a live one it reports true', (await pg.finishAudit(staleR.id, { status: 'complete', score: 99 })) === false && (await pg.getAudit(staleR.id)).status === 'failed' && (await pg.finishAudit(fresh.id, { status: 'complete', score: 99, summary: 'ok' })) === true);
  await pg.close();
}

/* ───────────── F. stale threshold — items 22-25 ───────────── */
{
  const sitemapCap = +(src('./seo/sitemap.js').match(/const MAX_SITEMAPS = (\d+);/) || [])[1];
  const pagespeedFactor = +(src('./seo/jobs.js').match(/limits\.requestTimeoutMs \* ([\d.]+)/) || [])[1];
  ok('drift guard: the sitemap fetch cap and the PageSpeed timeout factor the threshold is derived from were found in their source files', sitemapCap > 0 && pagespeedFactor > 0, `${sitemapCap} / ${pagespeedFactor}`);
  const derive = ({ maxPages, requestTimeoutMs, crawlDelayMs }) => Math.round(1.5 * ((1 + sitemapCap) * requestTimeoutMs + maxPages * (requestTimeoutMs + crawlDelayMs) + requestTimeoutMs * pagespeedFactor));

  ok('22. default threshold = 1.5 × (robots + every sitemap fetch + every page at full timeout + PageSpeed) from the CURRENT limits, read from the real sitemap.js/jobs.js constants', staleAuditMs() === derive(crawlLimits()), `${staleAuditMs()} vs ${derive(crawlLimits())}`);
  ok('22. with today\'s defaults that is 30 minutes', staleAuditMs() === 30 * MIN, String(staleAuditMs()));

  Object.assign(process.env, { SEO_MAX_PAGES: '10', SEO_REQUEST_TIMEOUT_MS: '2000', SEO_CRAWL_DELAY_MS: '100' });
  ok('22. the default follows the crawl limits when they change (it is derived, not a hard-coded 30 minutes)', staleAuditMs() === derive(crawlLimits()) && staleAuditMs() !== 30 * MIN, String(staleAuditMs()));
  for (const k of ['SEO_MAX_PAGES', 'SEO_REQUEST_TIMEOUT_MS', 'SEO_CRAWL_DELAY_MS']) delete process.env[k];

  process.env.SEO_STALE_AUDIT_MS = '90000';
  ok('23. SEO_STALE_AUDIT_MS overrides the derived default', staleAuditMs() === 90_000, String(staleAuditMs()));
  process.env.SEO_STALE_AUDIT_MS = '7200000';
  ok('23. …including to a larger value', staleAuditMs() === 7_200_000);
  for (const v of ['5000', '1', '59999']) { process.env.SEO_STALE_AUDIT_MS = v; ok(`24. an override below 60 seconds (${v} ms) is clamped up to 60 seconds`, staleAuditMs() === MIN, String(staleAuditMs())); }
  process.env.SEO_STALE_AUDIT_MS = '60000';
  ok('24. exactly 60 seconds is allowed as is', staleAuditMs() === MIN);
  for (const v of ['abc', '0', '-5', '']) { process.env.SEO_STALE_AUDIT_MS = v; ok(`an unusable override (${JSON.stringify(v)}) falls back to the derived default`, staleAuditMs() === derive(crawlLimits())); }
  delete process.env.SEO_STALE_AUDIT_MS;

  const keys = Object.keys(crawlLimits()).sort().join(',');
  ok('25. the threshold is separate from the crawl-limit object — crawlLimits() still returns exactly its original four fields', keys === 'crawlDelayMs,maxDepth,maxPages,requestTimeoutMs', keys);
  ok('25. …and staleAuditMs is its own export, not a crawlLimits() property', typeof staleAuditMs === 'function' && !('staleAuditMs' in crawlLimits()) && !/stale/i.test(src('./seo/limits.js').match(/export function crawlLimits\(\) \{[\s\S]*?\n\}/)[0]));
}

/* ───────────── G. wiring / scope proofs (source inspection, this file family's established convention) ───────────── */
{
  const dbSrc = src('./db.js'), jobsSrc = src('./seo/jobs.js');
  ok('db.js: finishAudit() is guarded by status IN (\'queued\',\'running\') — not the stricter = \'running\' that would break never-claimed queued call sites', /UPDATE seo_audits SET finished_at=\?[^"]*WHERE id=\? AND status IN \('queued','running'\)/.test(dbSrc) && !/WHERE id=\? AND status = 'running'/.test(dbSrc));
  ok('db.js: the sweep is one UPDATE scoped by website_id, queued/running only, and a started_at cutoff', /UPDATE seo_audits SET status = 'failed', finished_at = \?, summary = \? WHERE website_id = \? AND status IN \('queued','running'\) AND started_at < \?/.test(dbSrc));
  ok('db.js: no schema change — the seo_audits column list is exactly what it was, with no claimed_at/heartbeat/lease', /\['base_url', 'TEXT'\], \['pages_crawled', 'INTEGER'\], \['pages_planned', 'INTEGER'\], \['errors_count', 'INTEGER'\],\s*\['duration_ms', 'INTEGER'\], \['pagespeed', 'TEXT'\], \['specialist_diagnostics', 'TEXT'\],/.test(dbSrc) && !/\bclaimed_at\b|\bheartbeat\b|\blease\b/i.test(dbSrc));
  ok('db.js: started_at semantics unchanged — no UPDATE statement ever assigns it, and claimAudit() is exactly as before', !/UPDATE seo_audits SET[^"'`]*started_at/.test(dbSrc) && /UPDATE seo_audits SET status = 'running' WHERE id = \? AND status = 'queued'/.test(dbSrc));
  ok('jobs.js: the stale sweep runs BEFORE createAuditIfNoneActive() inside queueScan()', jobsSrc.indexOf('await recoverStaleAudits(store, website.id)') > 0 && jobsSrc.indexOf('await recoverStaleAudits(store, website.id)') < jobsSrc.indexOf('await store.createAuditIfNoneActive('));
  ok('jobs.js: the success path checks finishAudit()\'s result and returns BEFORE verification and specialist integration', jobsSrc.indexOf('if (!finished)') > 0 && jobsSrc.indexOf('if (!finished)') < jobsSrc.indexOf('await verifyAppliedRecommendations(store') && jobsSrc.indexOf('if (!finished)') < jobsSrc.indexOf('await runOnPageSpecialistIntegration(store'));
  ok('jobs.js: the failure path also checks finishAudit()\'s result, with no retry (finishAudit is called exactly twice in the whole file)', /const recorded = await store\.finishAudit\(/.test(jobsSrc) && (jobsSrc.match(/store\.finishAudit\(/g) || []).length === 2);
  ok('jobs.js: no heartbeat, lease, cancellation or global timeout was introduced', !/\bheartbeat\b|\blease\b|AbortController|setTimeout|\bclaimed_at\b/i.test(jobsSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')));
  for (const [file, label] of [['./seo/routes.js', 'routes (API contract)'], ['./seo/apply.js', 'Safe Apply'], ['./seo/specialistIntegration.js', 'specialist integration'], ['./seo/orchestrator.js', 'orchestrator'], ['./seo/specialistRecommendationConverter.js', 'converter'], ['./seo/recommendations.js', 'recommendations'], ['./seo/crawler.js', 'crawler'], ['./seo/pagespeed.js', 'PageSpeed'], ['./auth.js', 'auth'], ['./admin/admin.js', 'admin UI']]) {
    ok(`scope: ${label} does not reference stale recovery`, !/failStaleAudits|staleAuditMs|STALE_AUDIT|recoverStaleAudits/.test(src(file)));
  }
}

raw.close();
await store.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
