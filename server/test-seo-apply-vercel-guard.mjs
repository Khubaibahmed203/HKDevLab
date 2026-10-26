// D8.2 — SEO Apply is refused on Vercel.
// Apply saves versioned CMS data, but Vercel serves the public pages as static files built at deploy time, so a saved title/description never reaches the
// HTML that search engines and the SEO scan read: Apply, and the re-scan that should verify it, do not work end to end there. The apply route therefore answers
// HTTP 501 (reason 'unavailable-on-vercel') whenever process.env.VERCEL is set — FIRST, before the rate limiter and before any read — and there is no
// environment switch that turns it back on. Everything else (scans, issues, recommendations, approve/reject, history, the CMS editor) and the behaviour off
// Vercel are unchanged; the admin page shows a note instead of an Apply button.
//
// Everything is synthetic and local (SQLite in a temp file, a fake ".test" website): nothing is crawled and nothing touches the network.
// Run: node server/test-seo-apply-vercel-guard.mjs
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';

const HOME_HOST = 'home-vercel-guard.test';
const dbFile = join(tmpdir(), 'hk-apply-vercel-guard.db');
for (const s of ['', '-wal', '-shm']) rmSync(dbFile + s, { force: true });
Object.assign(process.env, { SMTP_HOST: '', SETUP_TOKEN: '', GOOGLE_CLIENT_ID: '', NODE_ENV: 'development', PUBLIC_URL: `https://${HOME_HOST}`, SQLITE_PATH: dbFile });
delete process.env.DATABASE_URL;
delete process.env.VERCEL; delete process.env.VERCEL_ENV;

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { (cond ? pass++ : fail++); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };

const { createStore } = await import(new URL('./db.js', import.meta.url).href);
const { createSeoRouter } = await import(new URL('./seo/routes.js', import.meta.url).href);
const { DEFAULT_CONTENT } = await import(new URL('./content.js', import.meta.url).href);
const src = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const store = await createStore();
const home = await store.ensureWebsite(HOME_HOST, 'Home');
const audit = await store.createAudit(home.id, { baseUrl: `https://${HOME_HOST}`, pagesPlanned: 1, status: 'running' });
await store.createIssues(home.id, audit.id, [{ pageId: null, type: 'title-length', severity: 'warning', detail: 'x' }]);
const issue = (await store.listIssues({ websiteId: home.id, auditId: audit.id }))[0];
const doc = JSON.parse(JSON.stringify(DEFAULT_CONTENT)); doc.seo.title = 'Base Title'; doc.seo.description = 'Base description';
await store.seedContentIfAbsent(doc, 'seed@x.test', 'seed');
let seq = 0;
const rec = async ({ status = 'approved', type = 'title' } = {}) => {
  const c = await store.createRecommendation({ websiteId: home.id, issueId: issue.id, pageId: null, type, currentValue: 'Old', proposedValue: `Guard test ${type} ${++seq}`, reasoning: 'r', aiProvider: 'test', aiModel: 'test' });
  if (status === 'approved') await store.setRecommendationStatus(c.id, 'approved', { reviewedBy: 'seed@x.test' });
  return store.getRecommendation(c.id);
};
const snapshot = async () => ({ content: JSON.stringify(await store.getContent()), history: (await store.listVersions()).length });
const same = (a, b) => a.content === b.content && a.history === b.history;

/* a view of the store that counts the calls this step is about; every call still goes to the real store */
const calls = { getRecommendation: 0, getContent: 0, saveContentIfVersion: 0, transitionRecommendation: 0, getPage: 0 };
const view = { ...store };
for (const k of Object.keys(calls)) view[k] = (...a) => { calls[k] += 1; return store[k](...a); };
const resetCalls = () => { for (const k of Object.keys(calls)) calls[k] = 0; };
const touched = () => Object.values(calls).some((n) => n > 0);

let limiterCalls = 0;
const server = await new Promise((resolve) => {
  const app = express(); app.use(express.json());
  app.use((req, res, next) => { req.user = { id: 1, email: 'actor@x.test' }; next(); });
  app.use('/api/admin/seo', createSeoRouter(view, { limiter: { take: async () => { limiterCalls += 1; return false; } } }));
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const call = async (method, path) => {
  const r = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/seo${path}`, { method, headers: { 'content-type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
  const text = await r.text(); let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
};
const onVercel = () => { process.env.VERCEL = '1'; };
const offVercel = () => { delete process.env.VERCEL; };
const MSG_KEYS = JSON.stringify(['error', 'ok', 'reason']);

/* ═════════════ A. off Vercel: unchanged ═════════════ */
offVercel();
let a = await rec({ type: 'title' });
let before = await snapshot(); resetCalls(); limiterCalls = 0;
let r = await call('POST', `/recommendations/${a.id}/apply`);
const afterA = await snapshot();
ok('A1. off Vercel: an approved home recommendation is applied exactly as before (200, status applied)', r.status === 200 && r.body.ok === true && r.body.recommendation?.status === 'applied', JSON.stringify(r));
ok('A2. off Vercel: …the content is live, one version step and one history entry, and the limiter was consulted once', JSON.parse(afterA.content).data.seo.title === a.proposed_value && afterA.history === before.history + 1 && limiterCalls === 1, `${afterA.history} vs ${before.history}, limiter ${limiterCalls}`);
r = await call('GET', '/recommendations');
ok('A3. off Vercel: GET /recommendations says applyAvailable: true and still lists the recommendations', r.status === 200 && r.body.applyAvailable === true && Array.isArray(r.body.recommendations) && r.body.recommendations.some((x) => x.id === a.id), JSON.stringify(r.body).slice(0, 200));

/* ═════════════ B. on Vercel: refused, first, without touching anything ═════════════ */
const b = await rec({ type: 'description' });
const pendingForLater = await rec({ status: 'pending' });
before = await snapshot(); resetCalls(); limiterCalls = 0;
onVercel();
r = await call('POST', `/recommendations/${b.id}/apply`);
ok('B1. on Vercel: apply -> HTTP 501 with reason "unavailable-on-vercel", ok:false, and exactly the keys ok/reason/error', r.status === 501 && r.body.ok === false && r.body.reason === 'unavailable-on-vercel' && JSON.stringify(Object.keys(r.body).sort()) === MSG_KEYS, JSON.stringify(r));
ok('B2. on Vercel: the message is accurate — Vercel, static public pages, nothing was changed, approve/reject and the editor still work', /Vercel/.test(r.body.error) && /static files/.test(r.body.error) && /Nothing was changed/.test(r.body.error) && /approve or reject/.test(r.body.error) && /edit the site content/.test(r.body.error) && !/manual implementation/.test(r.body.error), r.body.error);
ok('B3. on Vercel: the recommendation is still "approved" — not failed, not applied, no applied_at, reviewer untouched', await (async () => { const row = await store.getRecommendation(b.id); return row.status === 'approved' && row.applied_at === null && row.reviewed_by === 'seed@x.test'; })());
ok('B4. on Vercel: no recommendation read, no content read, no content write, no page lookup, no status transition (the guard is the FIRST thing the route does)', !touched(), JSON.stringify(calls));
ok('B5. on Vercel: the rate limiter was never consulted', limiterCalls === 0, String(limiterCalls));
ok('B6. on Vercel: content, version and history are byte-for-byte unchanged', same(before, await snapshot()));

let all501 = true;
for (let i = 0; i < 30; i++) { const x = await call('POST', `/recommendations/${b.id}/apply`); if (x.status !== 501 || x.body.reason !== 'unavailable-on-vercel') all501 = false; }
ok('B7. on Vercel: 30 apply calls in a row all answer 501 — never 429 (the limiter is not reached) and never anything that changes state', all501 && limiterCalls === 0 && !touched());

for (const [label, id] of [['an unknown id', 999999], ['a non-numeric id', 'abc'], ['an already-applied recommendation', a.id], ['a pending recommendation', pendingForLater.id]]) {
  const x = await call('POST', `/recommendations/${id}/apply`);
  ok(`B8. on Vercel: ${label} -> the same 501 (not 404 / 409 — the guard comes before any lookup)`, x.status === 501 && x.body.reason === 'unavailable-on-vercel' && !touched(), JSON.stringify(x));
}

/* no override: nothing in the environment can switch it back on */
let overridden = false;
for (const [k, v] of [['SEO_APPLY_ON_VERCEL', '1'], ['SEO_APPLY_ENABLED', '1'], ['SEO_ALLOW_APPLY', 'true'], ['ALLOW_APPLY', '1'], ['NODE_ENV', 'production'], ['NODE_ENV', 'development'], ['VERCEL_ENV', 'production'], ['VERCEL_ENV', 'preview'], ['VERCEL_ENV', 'development']]) {
  const keep = process.env[k]; process.env[k] = v;
  const x = await call('POST', `/recommendations/${b.id}/apply`);
  if (x.status !== 501) overridden = true;
  if (keep === undefined) delete process.env[k]; else process.env[k] = keep;
}
ok('B9. on Vercel: NO environment switch re-enables Apply (SEO_APPLY_*/ALLOW_APPLY flags, NODE_ENV, VERCEL_ENV production/preview/development all still 501)', !overridden);
let anyValue = true;
for (const v of ['1', '0', 'true', 'false', 'preview', 'production', ' ']) { process.env.VERCEL = v; const x = await call('POST', `/recommendations/${b.id}/apply`); if (x.status !== 501) anyValue = false; }
ok('B10. on Vercel: any non-empty VERCEL value counts as Vercel (fail closed — even "0" or "false")', anyValue);
onVercel();

/* the rest of the workflow is untouched on Vercel */
const approveRes = await call('POST', `/recommendations/${pendingForLater.id}/approve`);
ok('B11. on Vercel: approve still works (200, status approved)', approveRes.status === 200 && approveRes.body.recommendation?.status === 'approved', JSON.stringify(approveRes));
const toReject = await rec({ status: 'pending' });
const rejectRes = await call('POST', `/recommendations/${toReject.id}/reject`);
ok('B12. on Vercel: reject still works (200, status rejected)', rejectRes.status === 200 && rejectRes.body.recommendation?.status === 'rejected', JSON.stringify(rejectRes));
r = await call('GET', '/recommendations');
ok('B13. on Vercel: GET /recommendations still lists them and says applyAvailable: false', r.status === 200 && r.body.applyAvailable === false && r.body.recommendations.length >= 4, JSON.stringify(r.body).slice(0, 200));
const reads = await Promise.all([call('GET', '/scans'), call('GET', '/scans/latest'), call('GET', '/pages'), call('GET', '/issues')]);
ok('B14. on Vercel: scans, latest scan, pages and issues are unchanged (all 200, none 501)', reads.every((x) => x.status === 200), JSON.stringify(reads.map((x) => x.status)));
const issuesRes = reads[3];
ok('B15. on Vercel: the issues list is intact', Array.isArray(issuesRes.body.issues) && issuesRes.body.issues.length >= 1);

/* leaving Vercel again: the guard is per request and left no trace — the recommendation that was refused applies normally */
offVercel();
before = await snapshot();
r = await call('POST', `/recommendations/${b.id}/apply`);
const afterB = await snapshot();
ok('B16. back off Vercel: the very recommendation that was refused applies normally (200, applied) — the guard stored nothing', r.status === 200 && r.body.recommendation?.status === 'applied' && JSON.parse(afterB.content).data.seo.description === b.proposed_value && afterB.history === before.history + 1, JSON.stringify(r));

/* ═════════════ C. source guarantees ═════════════ */
const routesSrc = src('./seo/routes.js');
const applyBlock = routesSrc.slice(routesSrc.indexOf("router.post('/recommendations/:id/apply'"), routesSrc.indexOf('return router;'));
ok('C1. source: the apply handler\'s FIRST statement is the onServerless() guard returning 501 (before the limiter)', /\/recommendations\/:id\/apply',\s*asyncH\(async \(req, res\) => \{\s*(\/\/[^\n]*\n\s*)?if \(onServerless\(\)\) return res\.status\(501\)\.json\(\{ ok: false, reason: 'unavailable-on-vercel'/.test(routesSrc) && routesSrc.indexOf("if (onServerless()) return res.status(501)") < routesSrc.indexOf('limiter.take(`seo-apply'));
ok('C2. source: the apply handler reads no environment variable of its own and nothing in routes.js names an apply override', !/process\.env/.test(applyBlock) && !/SEO_APPLY|ALLOW_APPLY/.test(routesSrc.replace(/\/\/[^\n]*/g, '')));
ok('C3. source: apply.js and the CMS save path are untouched by this step (no onServerless / VERCEL in apply.js)', !/onServerless|VERCEL/.test(src('./seo/apply.js')));

/* ═════════════ D. the admin page: no misleading Apply button ═════════════ */
const adminSrc = src('./admin/admin.js');
ok('D1. admin.js: the view passes applyAvailable only when the server says exactly true (fail closed)', /const applyAvailable = r\.data\.applyAvailable === true;/.test(adminSrc) && /seoRecommendationCard\(rec, \(\) => seoRecommendationsView\(main\), applyAvailable\)/.test(adminSrc));
const from = adminSrc.indexOf('function seoVerificationBadge(rec)'), to = adminSrc.indexOf('async function seoHistoryView');
const h = (tag, attrs, ...kids) => ({ tag, attrs: attrs || {}, kids: kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false) });
const walk = (n, acc = []) => { if (n && typeof n === 'object') { acc.push(n); (n.kids || []).forEach((k) => walk(k, acc)); } return acc; };
const stubs = { apiCalls: [], toasts: [], nextApi: { ok: true, status: 200, data: {} } };
const api = async (method, url) => { stubs.apiCalls.push([method, url]); return stubs.nextApi; };
const toast = (m, bad) => stubs.toasts.push([m, !!bad]);
let card;
try { card = new Function('h', 'api', 'toast', 'confirm', adminSrc.slice(from, to) + '\nreturn seoRecommendationCard;')(h, api, toast, () => true); } catch (e) { ok('D2. admin.js: the recommendation card code loads for the test', false, e.message); }
if (card) {
  const buttons = (n) => walk(n).filter((x) => x.tag === 'button').map((x) => x.attrs.text);
  const notes = (n) => walk(n).filter((x) => x.tag === 'p' && /not available on Vercel/.test(x.attrs.text || ''));
  const R = (status, type = 'description') => ({ id: 7, type, status, proposed_value: 'p', reasoning: 'r', current_value: 'c', ai_provider: 'x', ai_model: 'y' });
  ok('D2. approved + applyAvailable true (off Vercel): the Apply button is offered, no note', buttons(card(R('approved'), () => {}, true)).includes('Apply') && notes(card(R('approved'), () => {}, true)).length === 0);
  const blocked = card(R('approved'), () => {}, false);
  ok('D3. approved + applyAvailable false (Vercel): NO Apply button, and an honest one-line note instead', !buttons(blocked).includes('Apply') && notes(blocked).length === 1 && /static files/.test(notes(blocked)[0].attrs.text) && /approve or reject/.test(notes(blocked)[0].attrs.text));
  ok('D4. approved + applyAvailable missing (fail closed): no Apply button', !buttons(card(R('approved'), () => {})).includes('Apply') && notes(card(R('approved'), () => {})).length === 1);
  const pending = card(R('pending'), () => {}, false);
  ok('D5. pending on Vercel: Approve and Reject are still offered, no Apply, no note', buttons(pending).includes('Approve') && buttons(pending).includes('Reject') && !buttons(pending).includes('Apply') && notes(pending).length === 0);
  ok('D6. applied / rejected / failed on Vercel: no Apply button and no note', ['applied', 'rejected', 'failed'].every((s) => { const c = card(R(s), () => {}, false); return !buttons(c).includes('Apply') && notes(c).length === 0; }));
  // clicking Apply when the page believes it is available but the server refuses (a stale page): the server's own accurate message is shown, not the "target" message
  const live = card(R('approved'), () => {}, true); const applyBtn = walk(live).find((x) => x.tag === 'button' && x.attrs.text === 'Apply');
  stubs.apiCalls.length = 0; stubs.toasts.length = 0; stubs.nextApi = { ok: false, status: 501, data: { ok: false, reason: 'unavailable-on-vercel', error: 'SERVER MESSAGE' } };
  await applyBtn.onclick();
  ok('D7. a 501 "unavailable-on-vercel" shows the server\'s message as an error, not the "not about the home page" text', stubs.toasts.length === 1 && stubs.toasts[0][0] === 'SERVER MESSAGE' && stubs.toasts[0][1] === true && stubs.apiCalls.length === 1 && stubs.apiCalls[0][1] === '/api/admin/seo/recommendations/7/apply');
  stubs.toasts.length = 0; stubs.nextApi = { ok: false, status: 501, data: { ok: false, error: 'manual implementation required' } };
  await applyBtn.onclick();
  ok('D8. the existing 501 for a refused TARGET keeps its own message (behaviour unchanged)', stubs.toasts.length === 1 && /not about this site's home page/.test(stubs.toasts[0][0]));
  stubs.toasts.length = 0; stubs.nextApi = { ok: true, status: 200, data: { ok: true } };
  await applyBtn.onclick();
  ok('D9. a successful apply (off Vercel) still reports success', stubs.toasts.length === 1 && /Applied/.test(stubs.toasts[0][0]) && stubs.toasts[0][1] === false);
}

server.close();
try { await store.close?.(); } catch { /* best effort */ }
for (const s of ['', '-wal', '-shm']) rmSync(dbFile + s, { force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
