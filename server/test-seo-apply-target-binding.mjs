// Phase 4 Hardening #11A — SEO Apply is bound to its target.
// Apply writes ONE thing: the site-wide seo.title / seo.description, i.e. the HOME page's. It used to ignore a recommendation's website_id and
// page_id, so an approved recommendation about ANOTHER website, or about /about, would overwrite the home page's title or description.
// Now, before anything is read or written, the recommendation must belong to the configured home website and, when it names a page, that
// page must be the home page "/" of that website. Anything else gets the existing "manual implementation required" answer (HTTP 501): no
// content read, no content write, no history entry, no status change — the recommendation stays approved. page_id = null stays applicable.
//
// NOT part of this step (deferred, see the Hardening #11 report): any comparison of the recommendation's current_value with the live content.
// current_value is the crawled page's title/description, which on a static (Vercel) deployment is not guaranteed to equal content.seo.*.
//
// Everything is synthetic and local: websites are fake ".test" names, nothing is crawled and nothing touches the network.
// Run: node server/test-seo-apply-target-binding.mjs
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { newDb } from 'pg-mem';

const HOME_HOST = 'home-binding.test', OTHER_HOST = 'other-binding.test', PORT_HOST = 'dev-binding.test:8899';
const dbFiles = [];
const freshDbPath = (name) => { const f = join(tmpdir(), `hk-apply-target-binding-${name}.db`); for (const s of ['', '-wal', '-shm']) rmSync(f + s, { force: true }); dbFiles.push(f); return f; };
Object.assign(process.env, { SMTP_HOST: '', SETUP_TOKEN: '', GOOGLE_CLIENT_ID: '', NODE_ENV: 'development', PUBLIC_URL: `https://${HOME_HOST}` });
delete process.env.DATABASE_URL;

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { (cond ? pass++ : fail++); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };

const { createStore } = await import(new URL('./db.js', import.meta.url).href);
const { applyRecommendation } = await import(new URL('./seo/apply.js', import.meta.url).href);
const { createSeoRouter } = await import(new URL('./seo/routes.js', import.meta.url).href);
const { DEFAULT_CONTENT } = await import(new URL('./content.js', import.meta.url).href);
const src = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const MANUAL = 'manual implementation required';
const doc = () => { const d = JSON.parse(JSON.stringify(DEFAULT_CONTENT)); d.seo.title = 'Base Title'; d.seo.description = 'Base description'; return d; };

let n = 0;
const opened = [];
async function makeSqlite() { process.env.SQLITE_PATH = freshDbPath(`s${++n}`); const store = await createStore(); opened.push(store); return store; }
async function makePgMem() { const { Pool } = newDb().adapters.createPg(); const store = await createStore({ pool: new Pool() }); opened.push(store); return store; }

/** A view of the store that counts the calls this step is about. Every call still goes to the real store. */
function counted(store) {
  const calls = { getContent: 0, saveContentIfVersion: 0, getPage: 0, transitionRecommendation: 0 };
  const view = { ...store };
  for (const k of Object.keys(calls)) view[k] = (...a) => { calls[k] += 1; return store[k](...a); };
  return { view, calls, reset: () => { for (const k of Object.keys(calls)) calls[k] = 0; } };
}
const newestHistoryId = async (store) => (await store.listVersions())[0]?.id ?? 0;
const snapshot = async (store) => ({ content: JSON.stringify(await store.getContent()), history: await newestHistoryId(store), historyCount: (await store.listVersions()).length });
const same = (a, b) => a.content === b.content && a.history === b.history && a.historyCount === b.historyCount;

/** A fresh store holding: the home website, another website, a spread of pages (valid and invalid targets), content, and an issue to hang recommendations on. */
async function environment(make) {
  const store = await make();
  const home = await store.ensureWebsite(HOME_HOST, 'Home'), other = await store.ensureWebsite(OTHER_HOST, 'Other');
  const audit = await store.createAudit(home.id, { baseUrl: `https://${HOME_HOST}`, pagesPlanned: 1, status: 'running' });
  await store.createIssues(home.id, audit.id, [{ pageId: null, type: 'title-length', severity: 'warning', detail: 'x' }]);
  const issue = (await store.listIssues({ websiteId: home.id, auditId: audit.id }))[0];
  const page = (websiteId, url) => store.upsertPage({ websiteId, url, finalUrl: url, statusCode: 200, contentType: 'text/html', title: 'A page title' });
  const pages = {
    home: await page(home.id, `https://${HOME_HOST}/`),                              // the home page "/"
    homeHttp: await page(home.id, `http://${HOME_HOST}/`),                           // same host, http: still the home page
    about: await page(home.id, `https://${HOME_HOST}/about`),                        // another page of the home website
    nested: await page(home.id, `https://${HOME_HOST}/blog/post`),
    query: await page(home.id, `https://${HOME_HOST}/?ref=campaign`),                // a different crawled URL, not "/"
    credentials: await page(home.id, `https://u:p@${HOME_HOST}/`),                   // userinfo: not the plain root URL
    userOnly: await page(home.id, `https://someone@${HOME_HOST}/`),
    passwordOnly: await page(home.id, `https://:p@${HOME_HOST}/`),
    port: await page(home.id, `https://${HOME_HOST}:8443/`),                         // another origin on the same name
    www: await page(home.id, `https://www.${HOME_HOST}/`),
    ftp: await page(home.id, `ftp://${HOME_HOST}/`),                                 // the root path on the right host, but not an http(s) page
    junk: await page(home.id, 'this is not a url'),                                  // an unparseable stored URL must not throw
    foreignHostUnderHome: await page(home.id, `https://${OTHER_HOST}/`),             // belongs to the home website row, but is another host's root
    otherSiteHome: await page(other.id, `https://${OTHER_HOST}/`),                   // the other website's own home page
    otherSiteWithHomeUrl: await page(other.id, `https://${HOME_HOST}/`),             // the other website's row with the home URL
  };
  await store.seedContentIfAbsent(doc(), 'seed@x.test', 'seed');
  let seq = 0;
  const rec = async ({ websiteId = home.id, pageId = null, type = 'title', value } = {}) => {
    const created = await store.createRecommendation({ websiteId, issueId: issue.id, pageId, type, currentValue: 'Old', proposedValue: value ?? `Applied ${type} ${++seq}`, reasoning: 'r', aiProvider: 'test', aiModel: 'test' });
    await store.setRecommendationStatus(created.id, 'approved', { reviewedBy: 'seed@x.test' });
    return store.getRecommendation(created.id);
  };
  return { store, home, other, pages, rec, issue };
}

/** Calls applyRecommendation() on a counting view and reports what it did and what changed. */
async function attempt(env, spec, opts = {}) {
  const r = await env.rec(spec);
  const before = await snapshot(env.store);
  const { view, calls } = counted(env.store);
  const result = await applyRecommendation(view, r, { userEmail: 'actor@x.test', homeWebsite: env.home, ...opts });
  return { rec: r, result, calls, unchanged: same(before, await snapshot(env.store)), after: await env.store.getContent() };
}
const isManual = (a) => JSON.stringify(a.result) === JSON.stringify({ ok: false, error: MANUAL });
const touchedNothing = (a) => a.calls.getContent === 0 && a.calls.saveContentIfVersion === 0 && a.unchanged;

/* ═════════════ part 1: applyRecommendation() itself, on SQLite and on the PostgreSQL adapter (pg-mem) ═════════════ */
async function functionSuite(label, make) {
  const T = (name) => `[${label}] ${name}`;
  const env = await environment(make);
  const { store, home, other, pages } = env;

  /* accepted targets */
  for (const type of ['title', 'description']) {
    const a = await attempt(env, { type, pageId: null, value: `Home ${type} (no page)` });
    ok(T(`1. home website + page_id null (${type}): applied exactly as before — one read, one compare-and-swap, no page lookup`), a.result.ok === true && a.after.data.seo[type] === `Home ${type} (no page)` && a.calls.getContent === 1 && a.calls.saveContentIfVersion === 1 && a.calls.getPage === 0, JSON.stringify([a.result, a.calls]));
    const b = await attempt(env, { type, pageId: pages.home, value: `Home ${type} (home page)` });
    ok(T(`2. home website + the home page "/" (${type}): applied — one read, one compare-and-swap, one page lookup`), b.result.ok === true && b.after.data.seo[type] === `Home ${type} (home page)` && b.calls.getContent === 1 && b.calls.saveContentIfVersion === 1 && b.calls.getPage === 1, JSON.stringify([b.result, b.calls]));
  }
  {
    const a = await attempt(env, { pageId: pages.homeHttp, value: 'Home title over http' });
    ok(T('2. …the home page crawled over http (same host) is also the home page'), a.result.ok === true && a.after.data.seo.title === 'Home title over http', JSON.stringify(a.result));
  }
  {
    const live = (await store.getContent()).data.seo.title;
    const a = await attempt(env, { pageId: pages.home, value: live });
    ok(T('2. …a proposal that is already live at the right target is still the existing no-op success (nothing written)'), a.result.ok === true && a.result.unchanged === true && a.calls.saveContentIfVersion === 0 && a.unchanged, JSON.stringify(a.result));
  }

  /* refused targets: the answer is the existing "manual implementation required", and nothing is read or written */
  const refused = [
    ['3. another website, no page (title)', { websiteId: other.id, pageId: null }],
    ['3. another website, no page (description)', { websiteId: other.id, pageId: null, type: 'description' }],
    ['3. another website, but naming the home website\'s home page', { websiteId: other.id, pageId: pages.home }],
    ['3. another website, naming its own home page "/"', { websiteId: other.id, pageId: pages.otherSiteHome }],
    ['3. a website id that does not exist', { websiteId: 987654, pageId: null }],
    ['4. home website, another page (/about)', { pageId: pages.about }],
    ['4. home website, another page (description)', { pageId: pages.about, type: 'description' }],
    ['4. home website, a nested page (/blog/post)', { pageId: pages.nested }],
    ['4. home website, the home URL with a query string', { pageId: pages.query }],
    ['4. home website, the home URL with credentials (user:pass@)', { pageId: pages.credentials }],
    ['4. home website, the home URL with a user name only', { pageId: pages.userOnly }],
    ['4. home website, the home URL with a password only', { pageId: pages.passwordOnly }],
    ['4. home website, the same name on another port', { pageId: pages.port }],
    ['4. home website, the www. host', { pageId: pages.www }],
    ['4. home website, a non-http(s) URL on the home host (ftp:)', { pageId: pages.ftp }],
    ['4. home website, a stored URL that is not parseable (no throw)', { pageId: pages.junk }],
    ['4. a page row of the home website whose URL is another host\'s root', { pageId: pages.foreignHostUnderHome }],
    ['4. a page row of ANOTHER website, even with the home URL', { pageId: pages.otherSiteWithHomeUrl }],
    ['5. a page_id that does not exist', { pageId: 999999 }],
    ['5. page_id 0 (not null, and no such page)', { pageId: 0 }],
  ];
  for (const [name, spec] of refused) {
    const a = await attempt(env, { ...spec, value: `SHOULD NEVER BE LIVE (${name})` });
    ok(T(`${name}: refused as "manual implementation required" — no content read, no write, no history`), isManual(a) && touchedNothing(a), JSON.stringify([a.result, a.calls, a.unchanged]));
  }

  /* the binding comes first, before validation and before the "already live" shortcut */
  {
    const a = await attempt(env, { websiteId: other.id, value: 'A'.repeat(200) });
    ok(T('6. wrong target + an invalid proposal: still the manual answer — never a validation failure (which the route would record as failed)'), isManual(a) && touchedNothing(a) && a.result.details === undefined, JSON.stringify(a.result));
    const live = (await store.getContent()).data.seo.title;
    const b = await attempt(env, { websiteId: other.id, value: live });
    ok(T('6. wrong target + a proposal equal to the live value: manual, not the "unchanged" success'), isManual(b) && b.result.unchanged === undefined && touchedNothing(b), JSON.stringify(b.result));
    const c = await attempt(env, { pageId: pages.about, value: 'B'.repeat(200) });
    ok(T('6. wrong page + an invalid proposal: manual as well'), isManual(c) && touchedNothing(c), JSON.stringify(c.result));
  }
  {
    const a = await attempt(env, { type: 'heading', value: 'x' });
    const b = await attempt(env, { type: 'heading', websiteId: other.id, value: 'x' });
    ok(T('7. an unsupported type is unchanged: manual, and nothing read or written (right target or wrong)'), isManual(a) && touchedNothing(a) && isManual(b) && touchedNothing(b));
  }

  /* fail closed: a caller that does not say which website is home is not trusted */
  const good = { id: 1, type: 'title', proposed_value: 'Closed Door Title', website_id: home.id, page_id: null };
  const closed = [
    ['no homeWebsite option', undefined], ['homeWebsite null', null], ['homeWebsite {}', {}], ['homeWebsite id 0', { id: 0, domain: HOME_HOST }],
    ['homeWebsite id null', { id: null, domain: HOME_HOST }], ['homeWebsite id "abc"', { id: 'abc', domain: HOME_HOST }], ['homeWebsite id 1.5', { id: 1.5, domain: HOME_HOST }], ['homeWebsite id -1', { id: -1, domain: HOME_HOST }],
  ];
  for (const [name, hw] of closed) {
    const before = await snapshot(store), { view, calls } = counted(store);
    const result = await applyRecommendation(view, good, { userEmail: 'a@x.test', homeWebsite: hw });
    ok(T(`8. fail closed — ${name}: refused as manual, nothing read or written`), JSON.stringify(result) === JSON.stringify({ ok: false, error: MANUAL }) && calls.getContent === 0 && calls.saveContentIfVersion === 0 && same(before, await snapshot(store)), JSON.stringify(result));
  }
  {
    // null/undefined/0 must never "equal" a missing home id (Number(null) is 0)
    const before = await snapshot(store);
    const traps = [[{ website_id: null }, { id: null }], [{ website_id: undefined }, {}], [{ website_id: 0 }, { id: 0 }], [{ website_id: '' }, { id: 0 }], [{}, undefined]];
    const results = [];
    for (const [r, hw] of traps) results.push(await applyRecommendation(store, { id: 2, type: 'title', proposed_value: 'Trap Title', page_id: null, ...r }, { userEmail: 'a@x.test', homeWebsite: hw }));
    ok(T('8. fail closed — a recommendation with no website can never match a home website with no id (null/undefined/0/"" traps)'), results.every((r) => r.ok === false && r.error === MANUAL) && same(before, await snapshot(store)), JSON.stringify(results));
  }
  {
    const a = await attempt(env, { pageId: pages.home, value: 'Domain-less home title' }, { homeWebsite: { id: home.id } });
    const b = await attempt(env, { pageId: null, value: 'Domain-less legacy title' }, { homeWebsite: { id: home.id } });
    ok(T('8. a home website without a domain cannot vouch for a page (refused) but still serves a page-less recommendation'), isManual(a) && touchedNothing(a) && b.result.ok === true);
  }
  {
    // ids arrive as numbers from the store on both backends, but a numeric string must not defeat a comparison either way
    const a = await attempt(env, { pageId: pages.home, value: 'String id title' }, { homeWebsite: { id: String(home.id), domain: HOME_HOST } });
    ok(T('9. ids are compared as numbers: the home website id as a numeric string still binds'), a.result.ok === true, JSON.stringify(a.result));
    const c = await attempt(env, { pageId: pages.home, value: 'Upper-case domain title' }, { homeWebsite: { id: home.id, domain: HOME_HOST.toUpperCase() } });
    ok(T('9. the host comparison ignores case (a configured domain written in capitals still binds the home page)'), c.result.ok === true, JSON.stringify(c.result));
  }
}

/* ═════════════ part 2: the Apply route on both backends — status, response shape, state machine, configured home ═════════════ */
async function routeSuite(label, make) {
  const T = (name) => `[${label}] ${name}`;
  const env = await environment(make);
  const { store, home, other, pages } = env;
  const { view, calls, reset } = counted(store);
  const server = await new Promise((resolve) => {
    const app = express(); app.use(express.json());
    app.use((req, res, next) => { req.user = { id: 1, email: 'actor@x.test' }; next(); });
    app.use('/api/admin/seo', createSeoRouter(view, { limiter: { take: async () => false } }));
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const post = async (id) => { const r = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/seo/recommendations/${id}/apply`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  const run = async (spec) => {
    const r = await env.rec(spec), before = await snapshot(store);
    reset();
    const res = await post(r.id);
    return { id: r.id, res, before, after: await snapshot(store), row: await store.getRecommendation(r.id), calls: { ...calls } };
  };

  /* accepted */
  for (const [name, spec] of [['page_id null (legacy)', { pageId: null }], ['the home page "/"', { pageId: pages.home }]]) {
    const a = await run({ ...spec, value: `Route title for ${name}` });
    const live = (await store.getContent()).data.seo.title;
    ok(T(`route: home website + ${name} -> 200 and applied, content live, one version step and one history entry`), a.res.status === 200 && a.res.body.recommendation?.status === 'applied' && a.row.status === 'applied' && !!a.row.applied_at && live === `Route title for ${name}` && a.after.historyCount === a.before.historyCount + 1, JSON.stringify([a.res.status, a.row.status, live]));
    ok(T(`route: …and the state machine ran as before: exactly one transition (approved -> applied)`), a.calls.transitionRecommendation === 1 && a.calls.saveContentIfVersion === 1 && a.calls.getContent === 1);
  }

  /* refused */
  const refused = [
    ['another website', { websiteId: other.id }],
    ['another website (description)', { websiteId: other.id, type: 'description' }],
    ['the home website\'s non-home page /about', { pageId: pages.about }],
    ['an unknown page id', { pageId: 999999 }],
    ['the home URL with a query string', { pageId: pages.query }],
  ];
  for (const [name, spec] of refused) {
    const a = await run({ ...spec, value: `SHOULD NEVER BE LIVE (${name})` });
    const exact = JSON.stringify(Object.keys(a.res.body).sort()) === JSON.stringify(['error', 'ok', 'recommendation']);
    ok(T(`route: ${name} -> the existing 501 "manual implementation required", same response shape, recommendation echoed as approved`), a.res.status === 501 && a.res.body.ok === false && a.res.body.error === MANUAL && a.res.body.recommendation?.status === 'approved' && a.res.body.recommendation?.id === a.id && exact, JSON.stringify(a.res));
    ok(T(`route: …left approved — not failed, not applied, no applied_at, reviewer untouched`), a.row.status === 'approved' && a.row.applied_at === null && a.row.reviewed_by === 'seed@x.test');
    ok(T(`route: …no content read, no content write, no history entry, no status transition`), a.calls.getContent === 0 && a.calls.saveContentIfVersion === 0 && a.calls.transitionRecommendation === 0 && same(a.before, a.after), JSON.stringify(a.calls));
  }
  {
    const a = await run({ websiteId: other.id, value: 'A'.repeat(200) });
    ok(T('route: wrong target with an invalid proposal -> 501 and still approved (a binding failure is never recorded as a validation failure)'), a.res.status === 501 && a.row.status === 'approved' && a.calls.transitionRecommendation === 0, JSON.stringify([a.res.status, a.row.status]));
    const again = await post(a.id);
    ok(T('route: …asking again gives the same 501 (not a 409: it really is still approved)'), again.status === 501 && (await store.getRecommendation(a.id)).status === 'approved');
  }

  /* the target is whatever the CONFIGURED home website is — nothing is hard-coded to one site */
  const realUrl = process.env.PUBLIC_URL;
  try {
    const forHome = await env.rec({ websiteId: home.id, pageId: pages.home, value: 'Home rec while another site is configured' });
    const forOther = await env.rec({ websiteId: other.id, pageId: pages.otherSiteHome, value: 'Other site title' });
    process.env.PUBLIC_URL = `https://${OTHER_HOST}`;
    reset();
    const h = await post(forHome.id), o = await post(forOther.id);
    ok(T('route: with another site configured as home, the former home site\'s recommendation is now refused (501)…'), h.status === 501 && (await store.getRecommendation(forHome.id)).status === 'approved', JSON.stringify(h));
    ok(T('route: …and that site\'s own home-page recommendation applies (200) — the binding follows the configured home website'), o.status === 200 && (await store.getContent()).data.seo.title === 'Other site title', JSON.stringify(o));

    // a development-style home with a port in its host
    process.env.PUBLIC_URL = `http://${PORT_HOST}`;
    const dev = await store.ensureWebsite(PORT_HOST, 'Dev');
    const devHome = await store.upsertPage({ websiteId: dev.id, url: `http://${PORT_HOST}/`, finalUrl: `http://${PORT_HOST}/`, statusCode: 200, contentType: 'text/html', title: 't' });
    const devAbout = await store.upsertPage({ websiteId: dev.id, url: `http://${PORT_HOST}/about`, finalUrl: `http://${PORT_HOST}/about`, statusCode: 200, contentType: 'text/html', title: 't' });
    const okDev = await env.rec({ websiteId: dev.id, pageId: devHome, value: 'Dev home title' }), noDev = await env.rec({ websiteId: dev.id, pageId: devAbout, value: 'Dev about title' });
    const d1 = await post(okDev.id), d2 = await post(noDev.id);
    ok(T('route: a home website whose host carries a port (development) binds its own "/" and refuses its other pages'), d1.status === 200 && d2.status === 501 && (await store.getContent()).data.seo.title === 'Dev home title', JSON.stringify([d1.status, d2.status]));
  } finally { process.env.PUBLIC_URL = realUrl; }

  server.closeAllConnections?.(); server.close();
}

await functionSuite('sqlite', makeSqlite);
await functionSuite('pg-mem', makePgMem);
await routeSuite('sqlite', makeSqlite);
await routeSuite('pg-mem', makePgMem);
{
  const store = await makePgMem();
  ok('the second backend really is the PostgreSQL adapter (pg-mem)', store.kind === 'postgres');
}

/* ═════════════ part 3: source-level scope proofs ═════════════ */
{
  const applySrc = src('./seo/apply.js'), routesSrc = src('./seo/routes.js'), dbSrc = src('./db.js');
  const applyCode = strip(applySrc), routesCode = strip(routesSrc);
  const bindAt = applyCode.indexOf('await targetsHomePage('), readAt = applyCode.indexOf('store.getContent(');
  ok('apply.js: the target binding runs BEFORE the content read (so a refused target reads nothing)', bindAt > 0 && readAt > bindAt);
  ok('apply.js: still exactly one content read and one compare-and-swap write — no loop, no retry, no second read', (applyCode.match(/store\.getContent\(/g) || []).length === 1 && (applyCode.match(/saveContentIfVersion\(/g) || []).length === 1 && !/\b(for|while)\s*\(/.test(applyCode));
  ok('apply.js: the refusal is the existing manual result — the same literal, used exactly twice (unsupported type, wrong target), no new error', (applyCode.match(/manual implementation required/g) || []).length === 2 && /if \(!\(await targetsHomePage\(store, rec, homeWebsite\)\)\) return \{ ok: false, error: 'manual implementation required' \};/.test(applyCode));
  ok('apply.js: no transaction, no state transition, no status handling', !/transitionRecommendation|BEGIN|COMMIT|ROLLBACK/.test(applyCode) && !/status/.test(applySrc.replace(/\/\*[\s\S]*?\*\//g, '')));
  ok('apply.js: the page lookup happens only for a recommendation that names a page (a null page_id returns before it)', applyCode.indexOf('if (rec.page_id == null) return true;') > 0 && applyCode.indexOf('if (rec.page_id == null) return true;') < applyCode.indexOf('store.getPage('));
  ok('apply.js: STALE-VALUE PROTECTION IS NOT IMPLEMENTED — current_value is never read or compared (deferred: it is not authoritative on a static deployment)', !/current_value|currentValue/.test(applyCode));
  const handler = routesCode.slice(routesCode.indexOf("router.post('/recommendations/:id/apply'"), routesCode.indexOf('return router;'));
  ok('routes.js: the apply handler passes the configured home website, resolved only after the 404 and "not approved" checks', /applyRecommendation\(store, rec, \{ userEmail: req\.user\.email, homeWebsite: await homeWebsite\(\) \}\)/.test(handler) && handler.indexOf("rec.status !== 'approved'") > 0 && handler.indexOf("rec.status !== 'approved'") < handler.indexOf('homeWebsite: await homeWebsite()'));
  ok('routes.js: the 501 mapping, the 409 conflict mapping and the failed transition are exactly as before', /if \(result\.error === 'manual implementation required'\) return res\.status\(501\)\.json\(\{ ok: false, error: result\.error, recommendation: rec \}\);/.test(handler) && /if \(result\.conflict\) return res\.status\(409\)/.test(handler) && (routesCode.match(/store\.transitionRecommendation\(/g) || []).length === 4);
  ok('db.js: this step added no schema, no transaction and no new store method (the content compare-and-swap is untouched)', !/BEGIN|COMMIT|ROLLBACK/.test(strip(dbSrc)) && (dbSrc.match(/async saveContentIfVersion\(/g) || []).length === 1);
}

for (const st of opened) await st.close?.();
for (const f of dbFiles) for (const s of ['', '-wal', '-shm']) { try { rmSync(f + s, { force: true }); } catch { /* best effort: a leftover temp file is harmless */ } }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
