// Phase 4 Hardening #2 — recommendation transition race guard.
// The approve/reject/apply routes used to read a recommendation's status, check it, then run an UNCONDITIONAL
// update by id — so two requests that read the same status could both "succeed" (the last writer silently winning).
// store.transitionRecommendation() is now the production transition API: only pending->approved, pending->rejected,
// approved->applied and approved->failed exist, and the UPDATE itself requires the row to still be in the expected
// previous status, so exactly one of any number of racing requests changes it.
//
// The races below are made deterministic with a barrier around the route store's getRecommendation(): every racing
// request is held until ALL of them have read the same pre-write state, and only then released toward the
// transition. (Plain concurrent HTTP calls against SQLite prove nothing: its driver is synchronous, so requests
// serialize and even the unguarded code would look safe.)
// pg-mem validates the SQL and the affected-row count on the PostgreSQL adapter; it can NOT prove real PostgreSQL
// row-lock behavior. Known, accepted limitation of this step: two concurrent Apply requests may still both write the
// identical content before the final status race is decided.
// Run: node server/test-seo-recommendation-race.mjs
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { newDb } from 'pg-mem';

const DB = join(tmpdir(), 'hk-seo-recommendation-race-test.db');
for (const s of ['', '-wal', '-shm']) rmSync(DB + s, { force: true });
Object.assign(process.env, { SQLITE_PATH: DB, SMTP_HOST: '', SETUP_TOKEN: '', GOOGLE_CLIENT_ID: '', NODE_ENV: 'development' });
delete process.env.DATABASE_URL;

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { (cond ? pass++ : fail++); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };

const { createStore } = await import(new URL('./db.js', import.meta.url).href);
const { createSeoRouter } = await import(new URL('./seo/routes.js', import.meta.url).href);
const src = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

/* ───────────── harness ───────────── */
const rowOf = (store, id) => store.getRecommendation(id);
async function seed(store, label) {
  const site = await store.ensureWebsite(`race-${label}.test`, label);
  const audit = await store.createAudit(site.id, { baseUrl: 'http://127.0.0.1:9', pagesPlanned: 1, status: 'running' });
  await store.createIssues(site.id, audit.id, [{ pageId: null, type: 'title-length', severity: 'warning', detail: 'x' }]);
  const issue = (await store.listIssues({ websiteId: site.id, auditId: audit.id }))[0];
  // Recommendations in any state are set up through the unguarded setter (tests only — it can jump anywhere)
  return async ({ type = 'title', value = 'A Perfectly Fine New Title', status = 'pending' } = {}) => {
    const rec = await store.createRecommendation({ websiteId: site.id, issueId: issue.id, pageId: null, type, currentValue: 'Old', proposedValue: value, reasoning: 'r', aiProvider: 'test', aiModel: 'test' });
    if (status === 'approved' || status === 'applied') await store.setRecommendationStatus(rec.id, 'approved', { reviewedBy: 'seed@x.test' });
    if (status === 'applied') await store.setRecommendationStatus(rec.id, 'applied', { applied: true });
    if (status === 'rejected') await store.setRecommendationStatus(rec.id, 'rejected', { reviewedBy: 'seed@x.test' });
    if (status === 'failed') await store.setRecommendationStatus(rec.id, 'failed', {});
    return rowOf(store, rec.id);
  };
}
async function serve(store) {
  const app = express(); app.use(express.json());
  app.use((req, res, next) => { req.user = { id: 1, email: req.get('x-user') || 'default@x.test' }; next(); });   // the routes' own logic, behind a stand-in for the session middleware
  app.use('/api/admin/seo', createSeoRouter(store, { limiter: { take: async () => false } }));
  return new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
}
const stop = (server) => { server.closeAllConnections?.(); server.close(); };
const post = async (server, path, user = 'default@x.test') => {
  const r = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/seo${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-user': user }, body: '{}' });
  return { status: r.status, body: await r.json() };
};
/** Holds the first `parties` reads of getRecommendation() until all of them have arrived, so every racing request
 *  has observed the same pre-write state before ANY of them proceeds. Later reads (the post-update fetch, the lost
 *  race's re-read) pass straight through. */
function withReadBarrier(base, parties) {
  let arrived = 0, release; const gate = new Promise((r) => (release = r));
  return { ...base, getRecommendation: async (id) => {
    const row = await base.getRecommendation(id);
    if (arrived < parties) { arrived += 1; if (arrived === parties) release(); await gate; }
    return row;
  } };
}
async function race(store, calls) {
  const server = await serve(withReadBarrier(store, calls.length));
  try { return await Promise.all(calls.map(([path, user]) => post(server, path, user))); } finally { stop(server); }
}
const codes = (results) => results.map((r) => r.status).sort().join(',');
const winnerIndex = (results) => Math.max(0, results.findIndex((r) => r.status === 200));   // 0 when nobody won — the status-code assertions then fail on their own, rather than this crashing

/* ───────────── the whole suite, run once per backend ───────────── */
async function suite(label, store) {
  const mk = await seed(store, label);
  const T = (name) => `[${label}] ${name}`;

  /* ── store level: transitionRecommendation() ── */
  {
    const pend = await mk();
    const a = await store.transitionRecommendation(pend.id, { from: 'pending', to: 'approved', reviewedBy: 'rev@x.test' });
    ok(T('valid: pending -> approved returns the updated row with the reviewer and time recorded'), a?.status === 'approved' && a.reviewed_by === 'rev@x.test' && !!a.reviewed_at && a.applied_at === null);
    const ap = await store.transitionRecommendation(pend.id, { from: 'approved', to: 'applied', applied: true });
    ok(T('valid: approved -> applied returns the updated row with applied_at recorded and the approver untouched'), ap?.status === 'applied' && !!ap.applied_at && ap.reviewed_by === 'rev@x.test' && ap.reviewed_at === a.reviewed_at);

    const rej = await mk();
    const r = await store.transitionRecommendation(rej.id, { from: 'pending', to: 'rejected', reviewedBy: 'rev@x.test' });
    ok(T('valid: pending -> rejected returns the updated row with the reviewer and time recorded'), r?.status === 'rejected' && r.reviewed_by === 'rev@x.test' && !!r.reviewed_at && r.applied_at === null);

    const fl = await mk({ status: 'approved' });
    const f = await store.transitionRecommendation(fl.id, { from: 'approved', to: 'failed' });
    ok(T('valid: approved -> failed returns the updated row; nothing else is touched (approver kept, no applied_at)'), f?.status === 'failed' && f.reviewed_by === 'seed@x.test' && f.applied_at === null);

    const INVALID = [['pending', 'applied'], ['pending', 'failed'], ['approved', 'approved'], ['rejected', 'approved'], ['rejected', 'applied'], ['failed', 'approved'],
      ['applied', 'approved'], ['applied', 'failed'], ['applied', 'applied'], ['pending', 'pending'], ['approved', 'rejected'], ['approved', 'pending'], ['rejected', 'pending'], ['rejected', 'rejected'], ['failed', 'applied'], ['bogus', 'approved'], ['pending', 'bogus'], [undefined, undefined]];
    const stateFor = { pending: 'pending', approved: 'approved', rejected: 'rejected', failed: 'failed', applied: 'applied' };
    const bad = [];
    for (const [from, to] of INVALID) {
      const rec = await mk({ status: stateFor[from] || 'pending' });
      const before = JSON.stringify(await rowOf(store, rec.id));
      let threw = false, returned;
      try { returned = await store.transitionRecommendation(rec.id, { from, to, reviewedBy: 'x@x.test', applied: true }); } catch { threw = true; }
      if (!threw || returned !== undefined || JSON.stringify(await rowOf(store, rec.id)) !== before) bad.push(`${from} -> ${to}`);
    }
    ok(T(`invalid pairs are rejected before any SQL runs and leave the row untouched (${INVALID.length} pairs, incl. pending->applied, pending->failed, approved->approved, rejected->approved, rejected->applied, failed->approved)`), bad.length === 0, bad.join('; '));

    const once = await mk();
    const first = await store.transitionRecommendation(once.id, { from: 'pending', to: 'approved', reviewedBy: 'first@x.test' });
    const second = await store.transitionRecommendation(once.id, { from: 'pending', to: 'approved', reviewedBy: 'second@x.test' });
    ok(T('already transitioned: the first call returns the updated row, the second returns null'), first?.status === 'approved' && second === null);
    const kept = await rowOf(store, once.id);
    ok(T('metadata ownership: the loser did not overwrite the winner\'s reviewed_by, reviewed_at or status'), kept.reviewed_by === 'first@x.test' && kept.reviewed_at === first.reviewed_at && kept.status === 'approved');
    ok(T('a valid pair against the wrong current state matches nothing: approving a rejected recommendation returns null and changes nothing'), (await store.transitionRecommendation(rej.id, { from: 'pending', to: 'approved', reviewedBy: 'late@x.test' })) === null && JSON.stringify(await rowOf(store, rej.id)) === JSON.stringify(r));
    ok(T('a missing recommendation returns null'), (await store.transitionRecommendation(999999, { from: 'pending', to: 'approved', reviewedBy: 'x@x.test' })) === null);

    const done = await mk({ status: 'approved' });
    const applied = await store.transitionRecommendation(done.id, { from: 'approved', to: 'applied', applied: true });
    const lateApply = await store.transitionRecommendation(done.id, { from: 'approved', to: 'applied', applied: true });
    const lateFail = await store.transitionRecommendation(done.id, { from: 'approved', to: 'failed' });
    const afterLate = await rowOf(store, done.id);
    ok(T('metadata ownership: a late second apply, or a late failure, returns null and cannot change the winner\'s status or applied_at'), lateApply === null && lateFail === null && afterLate.status === 'applied' && afterLate.applied_at === applied.applied_at);

    const loose = await mk();
    const viaSetter = await store.setRecommendationStatus(loose.id, 'applied', { applied: true });
    ok(T('setRecommendationStatus() is unchanged: still the unguarded setter (can jump pending -> applied; used by tests to build arbitrary states) and still returns the row'), viaSetter?.status === 'applied' && !!viaSetter.applied_at);
  }

  /* ── route level: status codes and bodies (existing API behavior) ── */
  {
    const server = await serve(store);
    const spec = [
      // [label, recommendation to create (null = none), action, expected HTTP status, expected final status]
      ['missing recommendation: approve -> 404', null, 'approve', 404, null],
      ['missing recommendation: reject -> 404', null, 'reject', 404, null],
      ['missing recommendation: apply -> 404', null, 'apply', 404, null],
      ['wrong approval state: approve an approved one -> 409', { status: 'approved' }, 'approve', 409, 'approved'],
      ['wrong approval state: approve a rejected one -> 409', { status: 'rejected' }, 'approve', 409, 'rejected'],
      ['wrong rejection state: reject an approved one -> 409', { status: 'approved' }, 'reject', 409, 'approved'],
      ['wrong rejection state: reject a rejected one -> 409', { status: 'rejected' }, 'reject', 409, 'rejected'],
      ['wrong apply state: apply a pending one -> 409', {}, 'apply', 409, 'pending'],
      ['wrong apply state: apply a rejected one -> 409', { status: 'rejected' }, 'apply', 409, 'rejected'],
      ['wrong apply state: apply an applied one -> 409', { status: 'applied' }, 'apply', 409, 'applied'],
      ['wrong apply state: apply a failed one -> 409', { status: 'failed' }, 'apply', 409, 'failed'],
      ['unsupported apply type (heading) -> 501, status left at approved', { type: 'heading', status: 'approved' }, 'apply', 501, 'approved'],
      ['apply validation failure (over-length title) -> 422, recorded as failed', { value: 'A'.repeat(200), status: 'approved' }, 'apply', 422, 'failed'],
      ['successful approve -> 200', {}, 'approve', 200, 'approved'],
      ['successful reject -> 200', {}, 'reject', 200, 'rejected'],
      ['successful apply -> 200', { status: 'approved' }, 'apply', 200, 'applied'],
    ];
    for (const [name, recSpec, action, wantStatus, wantFinal] of spec) {
      const rec = recSpec ? await mk(recSpec) : null;
      const res = await post(server, `/recommendations/${rec ? rec.id : 999999}/${action}`, 'actor@x.test');
      const final = rec ? (await rowOf(store, rec.id)).status : null;
      const shapeOk = wantStatus === 200 ? res.body.ok === true && res.body.recommendation?.status === wantFinal : res.body.ok === false && typeof res.body.error === 'string';
      ok(T(`${name}`), res.status === wantStatus && final === wantFinal && shapeOk, `${res.status} ${final} ${JSON.stringify(res.body)}`);
    }
    const pre = await mk({ status: 'approved' });
    ok(T('the up-front 409 wording is unchanged'), (await post(server, `/recommendations/${pre.id}/approve`)).body.error === 'Only a pending recommendation can be approved (this one is approved).');
    const okApprove = await mk();
    const approved = await post(server, `/recommendations/${okApprove.id}/approve`, 'boss@x.test');
    ok(T('a successful approve returns {ok, recommendation} with the reviewer recorded'), approved.body.ok === true && approved.body.recommendation.reviewed_by === 'boss@x.test');
    stop(server);
  }

  /* ── route level: deterministic races (every request reads the same pre-write state first) ── */
  {
    const a = await mk();
    const res = await race(store, [[`/recommendations/${a.id}/approve`, 'a@x.test'], [`/recommendations/${a.id}/approve`, 'b@x.test']]);
    const final = await rowOf(store, a.id), w = winnerIndex(res), loser = res[1 - w];
    ok(T('Case A, approve || approve: exactly one 200 and one 409, final status approved'), codes(res) === '200,409' && final.status === 'approved', JSON.stringify(res.map((x) => x.status)));
    ok(T('Case A: the winner owns the metadata (final reviewed_by is the request that got the 200)'), final.reviewed_by === ['a@x.test', 'b@x.test'][w] && res[w].body.recommendation.reviewed_at === final.reviewed_at);
    ok(T('Case A: the loser\'s 409 reports the CURRENT status (approved), not the outdated one it read (pending)'), loser.body.ok === false && loser.body.error === 'Only a pending recommendation can be approved (this one is approved).', JSON.stringify(loser.body));
  }
  {
    const b = await mk();
    const res = await race(store, [[`/recommendations/${b.id}/reject`, 'a@x.test'], [`/recommendations/${b.id}/reject`, 'b@x.test']]);
    const final = await rowOf(store, b.id), w = winnerIndex(res);
    ok(T('Case B, reject || reject: exactly one 200 and one 409, final status rejected'), codes(res) === '200,409' && final.status === 'rejected', JSON.stringify(res.map((x) => x.status)));
    ok(T('Case B: the winner owns the metadata, and the loser\'s 409 reports the current status (rejected)'), final.reviewed_by === ['a@x.test', 'b@x.test'][w] && res[1 - w].body.error === 'Only a pending recommendation can be rejected (this one is rejected).');
  }
  for (const [order, calls] of [['approve || reject', ['approve', 'reject']], ['reject || approve', ['reject', 'approve']]]) {
    const c = await mk();
    const res = await race(store, calls.map((action, i) => [`/recommendations/${c.id}/${action}`, i ? 'second@x.test' : 'first@x.test']));
    const final = await rowOf(store, c.id), w = winnerIndex(res);
    const winnerAction = calls[w], loserAction = calls[1 - w];
    const target = { approve: 'approved', reject: 'rejected' };
    ok(T(`Case C, ${order}: exactly one 200 and one 409`), codes(res) === '200,409', JSON.stringify(res.map((x) => x.status)));
    ok(T(`Case C, ${order}: the final state is exactly what the winning operation (${winnerAction}) set — a loser can never overwrite it`), final.status === target[winnerAction] && final.reviewed_by === (w ? 'second@x.test' : 'first@x.test'), `${final.status} ${final.reviewed_by}`);
    ok(T(`Case C, ${order}: the loser (${loserAction}) is told the current status`), res[1 - w].body.error === `Only a pending recommendation can be ${target[loserAction]} (this one is ${final.status}).`, res[1 - w].body.error);
  }
  {
    const d = await mk({ status: 'approved' });
    const res = await race(store, [[`/recommendations/${d.id}/apply`, 'a@x.test'], [`/recommendations/${d.id}/apply`, 'b@x.test']]);
    const final = await rowOf(store, d.id), w = winnerIndex(res);
    ok(T('Case D, apply || apply: exactly one 200 and one 409, final status applied (single winner of approved -> applied)'), codes(res) === '200,409' && final.status === 'applied' && !!final.applied_at, JSON.stringify(res.map((x) => x.status)));
    ok(T('Case D: the winner\'s applied_at is the one on record, and the loser\'s 409 reports the current status (applied)'), res[w].body.recommendation?.applied_at === final.applied_at && res[1 - w].body.error === 'Only an approved recommendation can be applied (this one is applied).', JSON.stringify(res.map((x) => x.body.error || null)));
  }
  {
    const e = await mk({ value: 'A'.repeat(200), status: 'approved' });
    const res = await race(store, [[`/recommendations/${e.id}/apply`, 'a@x.test'], [`/recommendations/${e.id}/apply`, 'b@x.test']]);
    ok(T('two racing applies of an invalid proposal: one 422 (the winner records approved -> failed), the other a 409 naming the current status; final status failed'), codes(res) === '409,422' && (await rowOf(store, e.id)).status === 'failed' && res.find((x) => x.status === 409).body.error === 'Only an approved recommendation can be applied (this one is failed).', JSON.stringify(res.map((x) => [x.status, x.body.error])));
  }
}

await suite('sqlite', await createStore());
const { Pool } = newDb().adapters.createPg();
const pgStore = await createStore({ pool: new Pool() });
ok('the second backend really is the PostgreSQL adapter (pg-mem)', pgStore.kind === 'postgres');
await suite('pg-mem', pgStore);

/* ───────────── wiring / scope proofs (source inspection, this file family's established convention) ───────────── */
{
  const dbSrc = src('./db.js'), routesSrc = src('./seo/routes.js');
  const method = dbSrc.slice(dbSrc.indexOf('async transitionRecommendation('), dbSrc.indexOf('async transitionRecommendation(') + 1400);
  ok('db.js: the transition SQL requires the exact previous status in its WHERE clause', /UPDATE seo_recommendations SET status = \?[^`]*WHERE id = \? AND status = \?`/.test(method) && /, id, from\]\)/.test(method));
  ok('db.js: the allow-list is exactly the four production transitions', /new Set\(\['pending>approved', 'pending>rejected', 'approved>applied', 'approved>failed'\]\)/.test(dbSrc) && !/pending>applied|pending>failed/.test(dbSrc));
  ok('db.js: invalid pairs throw before the UPDATE statement', method.indexOf('throw new Error') > 0 && method.indexOf('throw new Error') < method.indexOf('UPDATE seo_recommendations'));
  ok('db.js: setRecommendationStatus() is byte-for-byte unchanged', dbSrc.includes("async setRecommendationStatus(id, status, { reviewedBy, applied } = {}) {\n      const at = now();\n      await db.run(\n        `UPDATE seo_recommendations SET status = ?${reviewedBy !== undefined ? ', reviewed_at = ?, reviewed_by = ?' : ''}${applied ? ', applied_at = ?' : ''} WHERE id = ?`,\n        [status, ...(reviewedBy !== undefined ? [at, reviewedBy] : []), ...(applied ? [at] : []), id]);\n      return this.getRecommendation(id);\n    },"));
  ok('db.js: no new status, schema change, or transaction was introduced', !/CHECK \(status|BEGIN|COMMIT|ROLLBACK|applying/i.test(dbSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')));
  ok('routes.js: all four production transitions use the guarded method, with exactly these from/to pairs', (routesSrc.match(/store\.transitionRecommendation\(/g) || []).length === 4
    && [["'pending'", "'approved'"], ["'pending'", "'rejected'"], ["'approved'", "'failed'"], ["'approved'", "'applied'"]].every(([f, t]) => routesSrc.split(`from: ${f}, to: ${t}`).length === 2));
  ok('routes.js: the unguarded setter is no longer called from any route', !/setRecommendationStatus/.test(routesSrc));
  ok('routes.js: the up-front status pre-checks (the fast path) are all still there', (routesSrc.match(/if \(rec\.status !== 'pending'\)/g) || []).length === 2 && (routesSrc.match(/if \(rec\.status !== 'approved'\)/g) || []).length === 1);
  ok('routes.js: no pending -> applied path exists', !/from: 'pending', to: 'applied'/.test(routesSrc) && !/from: 'pending', to: 'failed'/.test(routesSrc));
  ok('routes.js: a lost race re-reads the recommendation and answers with the existing 409/404 — never a success', /async function lostTransition\([\s\S]*?store\.getRecommendation\(id\)[\s\S]*?status\(404\)[\s\S]*?status\(409\)/.test(routesSrc));

  const productionFiles = [];
  for (const dir of ['.', './seo', './admin']) for (const f of readdirSync(fileURLToPath(new URL(dir + '/', import.meta.url)))) if (/\.(js|mjs)$/.test(f) && !f.startsWith('test-')) productionFiles.push(`${dir}/${f}`);
  const users = (needle) => productionFiles.filter((f) => src(f).includes(needle)).sort().join(',');
  ok('no automatic path: apart from the store itself, only routes.js calls the guarded transition', users('transitionRecommendation') === './db.js,./seo/routes.js', users('transitionRecommendation'));
  ok('no automatic path: nothing in production code other than db.js (the definition) calls the unguarded setter either', users('setRecommendationStatus') === './db.js', users('setRecommendationStatus'));
  for (const [file, label] of [['./seo/apply.js', 'Safe Apply'], ['./seo/specialistIntegration.js', 'specialist integration'], ['./seo/orchestrator.js', 'orchestrator'], ['./seo/specialistRecommendationConverter.js', 'converter'], ['./seo/jobs.js', 'scan jobs / stale-audit recovery'], ['./seo/crawler.js', 'crawler'], ['./admin/admin.js', 'admin UI']]) {
    ok(`scope: ${label} does not reference the transition API`, !/transitionRecommendation|RECOMMENDATION_TRANSITIONS/.test(src(file)));
  }
  ok('scope: apply.js is still exactly the same two-type content write (no new branch, no status handling)', /rec\.type === 'title' \|\| rec\.type === 'description'/.test(src('./seo/apply.js')) && !/status/.test(src('./seo/apply.js').replace(/\/\*[\s\S]*?\*\//g, '')));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
