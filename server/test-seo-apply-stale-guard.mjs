// Phase 4 — the stale-value guard for SEO Apply.
// A title/description recommendation is written against the text that was live when it was drafted. If a person edits that field in the CMS
// before the recommendation is applied, applying it would silently replace their newer text with an older proposal. The content compare-and-swap
// cannot see this: it only protects the instant between Apply's read and Apply's write.
//
// So createRecommendation() (the one place both the LLM path and the specialist path create recommendations) records `base_value`: the site's own
// seo.title / seo.description from the content row at that moment. Apply compares it with the live value of THAT ONE field (the single content read
// it already makes) and, if they differ, writes nothing, answers HTTP 409 with reason 'stale-value', and records the recommendation as failed through
// the existing guarded approved -> failed transition.
//
// Deliberately NOT the crawled `current_value`: on a static (Vercel) deployment that is build-time HTML, not the CMS, so it would never match once the
// CMS had been edited. NULL base_value (older rows, other types, no content row) means "no guard" — the behaviour those rows always had.
//
// Everything is synthetic and local: fake ".test" websites, the LLM provider mocked at the fetch boundary, nothing crawled, no network.
// Run: node server/test-seo-apply-stale-guard.mjs
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { newDb } from 'pg-mem';
import { DatabaseSync } from 'node:sqlite';

const HOME_HOST = 'home-stale.test', OTHER_HOST = 'other-stale.test';
const dbFiles = [];
const freshDbPath = (name) => { const f = join(tmpdir(), `hk-apply-stale-guard-${name}.db`); for (const s of ['', '-wal', '-shm']) rmSync(f + s, { force: true }); dbFiles.push(f); return f; };
Object.assign(process.env, { SMTP_HOST: '', SETUP_TOKEN: '', GOOGLE_CLIENT_ID: '', NODE_ENV: 'development', PUBLIC_URL: `https://${HOME_HOST}` });
delete process.env.DATABASE_URL;
delete process.env.ANTHROPIC_API_KEY;

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { (cond ? pass++ : fail++); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };

const { createStore } = await import(new URL('./db.js', import.meta.url).href);
const { applyRecommendation } = await import(new URL('./seo/apply.js', import.meta.url).href);
const { createSeoRouter } = await import(new URL('./seo/routes.js', import.meta.url).href);
const { runOnPageSpecialistIntegration } = await import(new URL('./seo/specialistIntegration.js', import.meta.url).href);
const { DEFAULT_CONTENT } = await import(new URL('./content.js', import.meta.url).href);
const src = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const clone = (o) => JSON.parse(JSON.stringify(o));
const doc = () => { const d = clone(DEFAULT_CONTENT); d.seo.title = 'Base Title'; d.seo.description = 'Base description'; return d; };
const CRAWLED = 'Crawled Static Title';   // what the crawler "saw": deliberately different from the CMS value, to prove it is never the base

/* ───────────── backends (each also hands back a raw SQL escape hatch, to simulate rows from before the column existed) ───────────── */
let n = 0;
const opened = [];
async function makeSqlite() {
  const file = freshDbPath(`s${++n}`); process.env.SQLITE_PATH = file;
  const store = await createStore(); opened.push(store);
  return { store, kind: 'sqlite', file, sql: async (q) => { const raw = new DatabaseSync(file); try { raw.exec(q); } finally { raw.close(); } } };
}
async function makePgMem() {
  const { Pool } = newDb().adapters.createPg(); const pool = new Pool();
  const store = await createStore({ pool }); opened.push(store);
  return { store, kind: 'pg', pool, sql: async (q) => { await pool.query(q); } };
}

/** A view of the store that counts the calls this guard is about. Every call still goes to the real store. */
function counted(store) {
  const calls = { getContent: 0, saveContentIfVersion: 0, transitionRecommendation: 0 };
  const view = { ...store };
  for (const k of Object.keys(calls)) view[k] = (...a) => { calls[k] += 1; return store[k](...a); };
  return { view, calls, reset: () => { for (const k of Object.keys(calls)) calls[k] = 0; } };
}
const newestHistoryId = async (store) => (await store.listVersions())[0]?.id ?? 0;
const snapshot = async (store) => ({ content: JSON.stringify(await store.getContent()), history: await newestHistoryId(store), count: (await store.listVersions()).length });
const same = (a, b) => a.content === b.content && a.history === b.history && a.count === b.count;

/** A fresh store: home + another website, a home page and another page, issues, and (unless told not to) seeded content. */
async function environment(make, { seed = true } = {}) {
  const h = await make(); const { store } = h;
  const home = await store.ensureWebsite(HOME_HOST, 'Home'), other = await store.ensureWebsite(OTHER_HOST, 'Other');
  const audit = await store.createAudit(home.id, { baseUrl: `https://${HOME_HOST}`, pagesPlanned: 1, status: 'running' });
  const page = (websiteId, url) => store.upsertPage({ websiteId, url, finalUrl: url, statusCode: 200, contentType: 'text/html', title: CRAWLED, description: 'Crawled description', auditId: audit.id });
  const pages = { home: await page(home.id, `https://${HOME_HOST}/`), about: await page(home.id, `https://${HOME_HOST}/about`), otherHome: await page(other.id, `https://${OTHER_HOST}/`) };
  await store.createIssues(home.id, audit.id, [
    { pageId: pages.home, type: 'title-length', severity: 'warning', detail: 'title is 90 characters' },
    { pageId: pages.home, type: 'description-length', severity: 'warning', detail: 'description is 20 characters' },
  ]);
  const issues = await store.listIssues({ websiteId: home.id, auditId: audit.id });
  const issue = issues[0];
  if (seed) await store.seedContentIfAbsent(doc(), 'seed@x.test', 'seed');
  let seq = 0;
  /** Created through the real store method (so base_value is captured by production code), then approved. */
  const rec = async ({ type = 'title', value, websiteId = home.id, pageId = null, approve = true } = {}) => {
    const created = await store.createRecommendation({ websiteId, issueId: issue.id, pageId, type, currentValue: CRAWLED, proposedValue: value ?? `Applied ${type} ${++seq}`, reasoning: 'r', aiProvider: 'test', aiModel: 'test' });
    if (approve) await store.setRecommendationStatus(created.id, 'approved', { reviewedBy: 'seed@x.test' });
    return store.getRecommendation(created.id);
  };
  /** A person editing the CMS, through the real compare-and-swap. */
  const edit = async (mutate) => {
    const row = await store.getContent(), d = clone(row.data); mutate(d);
    const r = await store.saveContentIfVersion(d, 'editor@x.test', 'edit', row.version);
    if (!r.ok) throw new Error('test setup: the editor save was refused');
  };
  return { ...h, home, other, audit, pages, issues, issue, rec, edit };
}

const serve = (store) => new Promise((resolve) => {
  const app = express(); app.use(express.json());
  app.use((req, res, next) => { req.user = { id: 1, email: 'actor@x.test' }; next(); });
  app.use('/api/admin/seo', createSeoRouter(store, { limiter: { take: async () => false } }));
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const stop = (s) => { s.closeAllConnections?.(); s.close(); };
const call = async (s, method, path) => { const r = await fetch(`http://127.0.0.1:${s.address().port}/api/admin/seo${path}`, { method, headers: { 'content-type': 'application/json' }, body: method === 'POST' ? '{}' : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) }; };

/* ═════════════ part 1: base_value capture in the shared store path, and the migration ═════════════ */
async function captureSuite(label, make) {
  const T = (name) => `[${label}] ${name}`;
  const env = await environment(make);
  const { store } = env;
  const t = await env.rec({ type: 'title', approve: false }), d = await env.rec({ type: 'description', approve: false });
  ok(T('1. a title recommendation records the live seo.title as base_value — not the crawled current_value'), t.base_value === 'Base Title' && t.current_value === CRAWLED, JSON.stringify([t.base_value, t.current_value]));
  ok(T('1. a description recommendation records the live seo.description'), d.base_value === 'Base description' && d.current_value === CRAWLED, JSON.stringify([d.base_value, d.current_value]));
  await env.edit((c) => { c.seo.title = 'Edited later'; });
  ok(T('1. …and it is a snapshot: a later CMS edit does not move it'), (await store.getRecommendation(t.id)).base_value === 'Base Title');
  const t2 = await env.rec({ type: 'title', approve: false });
  ok(T('1. …a recommendation created after the edit records the new live value'), t2.base_value === 'Edited later', t2.base_value);
  for (const type of ['heading', 'canonical', 'redirect-target', 'schema']) {
    const o = await env.rec({ type, approve: false });
    ok(T(`2. an unsupported type (${type}) gets no base: NULL`), o.base_value === null, JSON.stringify(o.base_value));
  }
  const bare = await environment(make, { seed: false });
  const noRow = await bare.rec({ type: 'title', approve: false });
  ok(T('2. no content row at all: NULL (no guard), not a guess from the defaults'), (await bare.store.getContent()) === null && noRow.base_value === null);
  await bare.store.seedContentIfAbsent({ hero: { lede: 'x' } }, 'seed@x.test', 'seed');                 // a document with no seo section
  const noSeo = await bare.rec({ type: 'description', approve: false });
  await bare.edit((c) => { c.seo = { title: 42 }; });                                                    // a non-string value
  const notString = await bare.rec({ type: 'title', approve: false });
  ok(T('2. a content row without that field, or with a non-string value there: NULL'), noSeo.base_value === null && notString.base_value === null, JSON.stringify([noSeo.base_value, notString.base_value]));

  // migration: idempotent, additive, rows from before the column read back NULL
  const row = (await store.listRecommendations({ websiteId: env.home.id })).find((r) => r.id === t.id);
  ok(T('3. the new column is exposed on the existing recommendation rows (additive: nothing else about them changed)'), 'base_value' in row && row.status === 'pending' && row.proposed_value === t.proposed_value);
}

/** PostgreSQL adapter: pg-mem cannot re-run the whole schema bootstrap on one database (it rejects the re-issued CREATE TABLE IF NOT EXISTS), so this
 *  checks the exact statement addColumn() issues for PostgreSQL — against a table that lost the column and then against one that already has it. */
async function pgMigrationSuite(label) {
  const T = (name) => `[${label}] ${name}`;
  const env = await environment(makePgMem);
  const t = await env.rec({ type: 'title', approve: false });
  await env.sql('ALTER TABLE seo_recommendations DROP COLUMN base_value');
  let e1 = null, e2 = null;
  try { await env.sql('ALTER TABLE seo_recommendations ADD COLUMN IF NOT EXISTS base_value TEXT'); } catch (e) { e1 = e; }
  try { await env.sql('ALTER TABLE seo_recommendations ADD COLUMN IF NOT EXISTS base_value TEXT'); } catch (e) { e2 = e; }
  ok(T('3. migration (PostgreSQL statement): adding the column to a table that lacks it works, and repeating it (already there) is a no-op'), !e1 && !e2, String(e1?.message || e2?.message).slice(0, 160));
  // a full scan, not a primary-key lookup: pg-mem's index lookup (WHERE id = …) keeps handing back the row object as it was before the column was
  // dropped, while a scan shows the table as it really is now (verified in isolation) — an emulator quirk, not something production can hit
  const oldBase = (await env.pool.query('SELECT id, base_value FROM seo_recommendations')).rows.find((r) => Number(r.id) === t.id)?.base_value;
  const fresh = await env.store.createRecommendation({ websiteId: env.home.id, issueId: env.issue.id, pageId: null, type: 'title', currentValue: CRAWLED, proposedValue: 'New after migration', reasoning: 'r', aiProvider: 'test', aiModel: 'test' });
  ok(T('3. …the existing row reads back NULL (no guard) and a new recommendation records its base'), oldBase === null && fresh.base_value === 'Base Title', JSON.stringify([oldBase, fresh.base_value]));
  ok(T('3. …and that statement is exactly what production issues for PostgreSQL (IF NOT EXISTS), with the SQLite path swallowing "already there"'), /ADD COLUMN \$\{db\.kind === 'postgres' \? 'IF NOT EXISTS ' : ''\}\$\{column\} \$\{type\}/.test(src('./db.js')));
}

async function migrationSuite(label, make, reopen) {
  const T = (name) => `[${label}] ${name}`;
  const env = await environment(make);
  const { store } = env;
  const t = await env.rec({ type: 'title', approve: false });
  await store.close(); opened.splice(opened.indexOf(store), 1);
  // simulate a database from before this change: the column does not exist, rows exist
  await env.sql('ALTER TABLE seo_recommendations DROP COLUMN base_value');
  let reopened, err = null;
  try { reopened = await reopen(env); opened.push(reopened); } catch (e) { err = e; }
  ok(T('3. migration: opening a database that lacks the column adds it without error'), !err && reopened, String(err?.message));
  if (!reopened) return;
  const old = await reopened.getRecommendation(t.id);
  ok(T('3. …the existing row survives untouched and reads back base_value NULL (= no guard, as before)'), old && old.id === t.id && old.proposed_value === t.proposed_value && old.base_value === null, JSON.stringify(old));
  const fresh = await reopened.createRecommendation({ websiteId: env.home.id, issueId: env.issue.id, pageId: null, type: 'title', currentValue: CRAWLED, proposedValue: 'New after migration', reasoning: 'r', aiProvider: 'test', aiModel: 'test' });
  ok(T('3. …and a recommendation created afterwards records its base'), fresh.base_value === 'Base Title', JSON.stringify(fresh.base_value));
  let again = null, e2 = null;
  try { again = await reopen(env); opened.push(again); } catch (e) { e2 = e; }
  ok(T('3. migration is idempotent: opening it a second time (column already there) does not fail'), !e2 && again, String(e2?.message));
}

/* ═════════════ part 2: BOTH creation paths record the base ═════════════ */
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (!u.startsWith('https://api.anthropic.com/')) return realFetch(url, opts);       // only the LLM provider is mocked; the local test servers pass straight through
  const body = JSON.parse(opts.body);
  const wantsDescription = /description/i.test(body.messages[0].content) && !/title-length/.test(body.messages[0].content);
  return new Response(JSON.stringify({ content: [{ type: 'tool_use', name: 'submit_recommendation', input: { proposedValue: wantsDescription ? 'A clear, accurate description of what HK DevLab builds and who it is for, in plain words.' : 'A Better, Clearer Title For HK DevLab', reasoning: 'Clearer and the right length.' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
};
async function creationPathsSuite(label, make) {
  const T = (name) => `[${label}] ${name}`;
  const env = await environment(make);
  const { store } = env;
  process.env.ANTHROPIC_API_KEY = 'test-key-not-a-real-secret';
  const server = await serve(store);
  try {
    const titleIssue = env.issues.find((i) => i.type === 'title-length'), descIssue = env.issues.find((i) => i.type === 'description-length');
    const a = await call(server, 'POST', `/issues/${titleIssue.id}/recommend`), b = await call(server, 'POST', `/issues/${descIssue.id}/recommend`);
    ok(T('4. LLM path (POST /issues/:id/recommend): a title recommendation records the live seo.title as its base'), a.status === 201 && a.body.recommendation?.type === 'title' && a.body.recommendation.base_value === 'Base Title' && a.body.recommendation.current_value === CRAWLED, JSON.stringify(a.body).slice(0, 220));
    ok(T('4. LLM path: a description recommendation records the live seo.description as its base'), b.status === 201 && b.body.recommendation?.type === 'description' && b.body.recommendation.base_value === 'Base description', JSON.stringify(b.body).slice(0, 220));
  } finally { stop(server); delete process.env.ANTHROPIC_API_KEY; }

  // the specialist path: the real agents -> orchestrator -> converter -> store.createRecommendation(), on its own website/audit
  const spec = await store.ensureWebsite('specialist-stale.test', 'Specialist');
  const audit = await store.createAudit(spec.id, { baseUrl: 'https://specialist-stale.test', pagesPlanned: 2, status: 'running' });
  const longTitle = 'This Is An Extremely Long And Overly Descriptive Page Title That Definitely Exceeds Sixty Characters By Quite A Lot';
  const longDescription = 'Padding words so this meta description is far longer than the limit. '.repeat(4);
  const tPage = await store.upsertPage({ websiteId: spec.id, url: 'https://specialist-stale.test/long-title', finalUrl: 'https://specialist-stale.test/long-title', statusCode: 200, title: longTitle, description: 'Fine.', auditId: audit.id });
  const dPage = await store.upsertPage({ websiteId: spec.id, url: 'https://specialist-stale.test/long-desc', finalUrl: 'https://specialist-stale.test/long-desc', statusCode: 200, title: 'Fine Title', description: longDescription, auditId: audit.id });
  await store.createIssues(spec.id, audit.id, [
    { pageId: tPage, type: 'title-length', severity: 'warning', detail: `title is ${longTitle.length} chars` },
    { pageId: dPage, type: 'description-length', severity: 'warning', detail: `description is ${longDescription.length} chars` },
  ]);
  await store.finishAudit(audit.id, { score: 70, status: 'complete', summary: '2 pages crawled, 2 issues found.', pagesCrawled: 2, errorsCount: 0, durationMs: 10 });
  await runOnPageSpecialistIntegration(store, spec.id, audit.id);
  const recs = (await store.listRecommendations({ websiteId: spec.id })).filter((r) => r.ai_provider === 'specialist-agent');
  const st = recs.find((r) => r.type === 'title'), sd = recs.find((r) => r.type === 'description');
  ok(T('5. specialist path: the integration really created a title and a description recommendation'), !!st && !!sd && st.current_value === longTitle, JSON.stringify(recs.map((r) => [r.type, r.ai_provider])));
  ok(T('5. specialist path: both record the SITE\'s live value as base_value — not the crawled current_value'), st?.base_value === 'Base Title' && sd?.base_value === 'Base description' && st?.base_value !== st?.current_value, JSON.stringify([st?.base_value, sd?.base_value]));
}

/* ═════════════ part 3: Apply — the guard and everything it must not disturb ═════════════ */
async function applySuite(label, make) {
  const T = (name) => `[${label}] ${name}`;
  const env = await environment(make);
  const { store, home, other, pages } = env;
  const { view, calls, reset } = counted(store);
  const server = await serve(view);
  const run = async (r) => { const before = await snapshot(store); reset(); const res = await call(server, 'POST', `/recommendations/${r.id}/apply`); return { res, before, after: await snapshot(store), row: await store.getRecommendation(r.id), calls: { ...calls } }; };

  /* base equals live -> applies exactly as before */
  {
    const r = await env.rec({ type: 'title', value: 'Fresh Title One' });
    const a = await run(r);
    ok(T('6. base equals live: Apply succeeds (200, applied), one read, one compare-and-swap, one transition'), a.res.status === 200 && a.row.status === 'applied' && (await store.getContent()).data.seo.title === 'Fresh Title One' && a.calls.getContent === 1 && a.calls.saveContentIfVersion === 1 && a.calls.transitionRecommendation === 1, JSON.stringify([a.res.status, a.calls]));
  }

  /* stale: the field changed after the recommendation was drafted */
  for (const [type, field, edited] of [['title', 'title', 'Edited by a person'], ['description', 'description', 'A description a person wrote']]) {
    const r = await env.rec({ type, value: `Proposal for ${type}` });
    await env.edit((c) => { c.seo[field] = edited; });
    const a = await run(r), b = a.res.body;
    ok(T(`7. stale ${type}: 409 with reason 'stale-value', ok false`), a.res.status === 409 && b.ok === false && b.reason === 'stale-value', JSON.stringify(a.res));
    ok(T(`7. …the message says the field changed, that nothing was written, and to generate a new recommendation from the Issues tab`), new RegExp(`SEO ${type} changed`).test(b.error) && /nothing was written/.test(b.error) && /new recommendation/.test(b.error) && /Issues tab/.test(b.error), b.error);
    ok(T(`7. …the updated recommendation is returned and is failed (via the guarded approved -> failed transition), with no applied_at`), b.recommendation?.id === r.id && b.recommendation.status === 'failed' && a.row.status === 'failed' && a.row.applied_at === null, JSON.stringify(b.recommendation));
    ok(T(`7. …no content write, no history entry, no compare-and-swap call: the person's text is still live`), a.calls.saveContentIfVersion === 0 && a.calls.getContent === 1 && same(a.before, a.after) && (await store.getContent()).data.seo[field] === edited, JSON.stringify(a.calls));
    ok(T(`7. …exactly one transition ran (approved -> failed)`), a.calls.transitionRecommendation === 1);
    const again = await call(server, 'POST', `/recommendations/${r.id}/apply`);
    ok(T(`7. …applying it again is refused by the ordinary up-front check (409, "this one is failed") — it can never be applied`), again.status === 409 && /this one is failed/.test(again.body.error) && again.body.reason === undefined, JSON.stringify(again));
  }

  /* a proposal that is already live is the existing no-op success, whatever the base */
  {
    const r = await env.rec({ type: 'title', value: 'Already There' });
    await env.edit((c) => { c.seo.title = 'Already There'; });
    const a = await run(r);
    ok(T('8. proposal already equals the live value: unchanged success (200, applied) even though the base differs — nothing written'), a.res.status === 200 && a.row.status === 'applied' && a.calls.saveContentIfVersion === 0 && same(a.before, a.after), JSON.stringify([a.res.status, a.calls]));
  }

  /* only the recommendation's own field matters */
  {
    const r1 = await env.rec({ type: 'title', value: 'Title Despite Other Edits' });
    await env.edit((c) => { c.hero.lede = 'an unrelated section changed'; c.seo.description = 'the other SEO field changed'; });
    const a = await run(r1);
    ok(T('9. an unrelated field AND the other SEO field changed after drafting: a title recommendation still applies'), a.res.status === 200 && (await store.getContent()).data.seo.title === 'Title Despite Other Edits', JSON.stringify(a.res));
    const r2 = await env.rec({ type: 'description', value: 'Description despite a title edit' });
    await env.edit((c) => { c.seo.title = 'The title was edited meanwhile'; });
    const b = await run(r2);
    ok(T('9. …and a description recommendation still applies when only the title changed'), b.res.status === 200 && (await store.getContent()).data.seo.description === 'Description despite a title edit', JSON.stringify(b.res));
  }

  /* legacy rows (no base): the behaviour they always had */
  {
    const r = await env.rec({ type: 'title', value: 'Legacy Row Title' });
    await env.sql(`UPDATE seo_recommendations SET base_value = NULL WHERE id = ${r.id}`);
    await env.edit((c) => { c.seo.title = 'Edited under a legacy row'; });
    const a = await run(r);
    ok(T('10. a legacy row (NULL base) is not guarded: it applies even though the title changed since it was drafted'), (await store.getRecommendation(r.id)).base_value === null && a.res.status === 200 && (await store.getContent()).data.seo.title === 'Legacy Row Title', JSON.stringify(a.res));
  }

  /* the target binding still comes first */
  {
    const wrongSite = await env.rec({ type: 'title', websiteId: other.id, pageId: pages.otherHome, value: 'Other Site Title' });
    const wrongPage = await env.rec({ type: 'title', pageId: pages.about, value: 'About Page Title' });
    await env.edit((c) => { c.seo.title = 'Edited so both look stale'; });
    for (const [name, r] of [['another website', wrongSite], ['a non-home page', wrongPage]]) {
      const a = await run(r);
      ok(T(`11. target binding takes precedence: ${name} that is ALSO stale gets the 501, not the stale answer`), a.res.status === 501 && a.res.body.error === 'manual implementation required' && a.res.body.reason === undefined && a.row.status === 'approved' && a.calls.transitionRecommendation === 0 && a.calls.getContent === 0 && same(a.before, a.after), JSON.stringify([a.res, a.calls]));
    }
  }

  /* validation keeps its own, unchanged outcome */
  {
    const r = await env.rec({ type: 'title', value: 'A'.repeat(200) });
    const a = await run(r);
    ok(T('12. an invalid proposal is still the validation failure (422, failed, with details) — not the stale answer'), a.res.status === 422 && a.row.status === 'failed' && Array.isArray(a.res.body.details) && a.res.body.reason === undefined, JSON.stringify(a.res).slice(0, 200));
  }

  /* two requests at once on one stale recommendation: one transition, no double handling */
  {
    const r = await env.rec({ type: 'title', value: 'Raced Stale Title' });
    await env.edit((c) => { c.seo.title = 'Edited before the race'; });
    reset();
    const [x, y] = await Promise.all([call(server, 'POST', `/recommendations/${r.id}/apply`), call(server, 'POST', `/recommendations/${r.id}/apply`)]);
    const stale = [x, y].filter((q) => q.body.reason === 'stale-value'), lost = [x, y].filter((q) => q.body.reason === undefined);
    ok(T('13. two simultaneous applies of one stale recommendation: both 409, exactly ONE is the stale answer, the other loses to it ("this one is failed"), final status failed, nothing written'), [x.status, y.status].join() === '409,409' && stale.length === 1 && lost.length === 1 && /this one is failed/.test(lost[0].body.error) && stale[0].body.recommendation?.status === 'failed' && (await store.getRecommendation(r.id)).status === 'failed' && (await store.getContent()).data.seo.title === 'Edited before the race', JSON.stringify([x, y]).slice(0, 300));
  }
  stop(server);

  /* a compare-and-swap conflict is a DIFFERENT outcome: a race inside this request, the recommendation stays approved, no reason */
  {
    const r = await env.rec({ type: 'title', value: 'Conflict Title' });
    let done = false;
    const racing = { ...store, getContent: async () => {                               // an editor saves an unrelated field between Apply's read and its write
      const row = await store.getContent();
      if (!done) { done = true; const d = clone(row.data); d.hero.lede = 'edited between read and write'; await store.saveContentIfVersion(d, 'editor@x.test', 'edit', row.version); }
      return row;
    } };
    const s2 = await serve(racing);
    const before = await snapshot(store);
    const res = await call(s2, 'POST', `/recommendations/${r.id}/apply`);
    stop(s2);
    const row = await store.getRecommendation(r.id);
    ok(T('14. a CAS conflict stays distinct from stale: 409 with the "content changed… apply it again" text, NO reason, and the recommendation stays approved'), res.status === 409 && res.body.ok === false && res.body.reason === undefined && /content changed/.test(res.body.error) && /apply it again/.test(res.body.error) && row.status === 'approved' && res.body.recommendation?.status === 'approved', JSON.stringify(res));
    ok(T('14. …and it wrote nothing of its own (only the editor\'s interleaved save is in the history)'), (await store.getContent()).data.seo.title !== 'Conflict Title' && (await newestHistoryId(store)) === before.history + 1);
  }

  /* function level: the result shapes the route maps */
  {
    const { view: v2, calls: c2 } = counted(store);
    const live = (await store.getContent()).data.seo.title;
    const stale = await applyRecommendation(v2, { id: 900, type: 'title', proposed_value: 'Function Level Proposal', website_id: home.id, page_id: null, base_value: `${live} (older)` }, { userEmail: 'a@x.test', homeWebsite: home });
    ok(T('15. applyRecommendation: stale is { ok:false, stale:true, error } — never conflict, never a write'), stale.ok === false && stale.stale === true && stale.conflict === undefined && typeof stale.error === 'string' && c2.getContent === 1 && c2.saveContentIfVersion === 0, JSON.stringify([stale, c2]));
    const legacy = await applyRecommendation(store, { id: 901, type: 'title', proposed_value: 'Function Level Legacy', website_id: home.id, page_id: null }, { userEmail: 'a@x.test', homeWebsite: home });
    ok(T('15. applyRecommendation: a row with no base_value property at all behaves as before (applies)'), legacy.ok === true && legacy.stale === undefined);
  }
}

await captureSuite('sqlite', makeSqlite);
await captureSuite('pg-mem', makePgMem);
await migrationSuite('sqlite', makeSqlite, async (env) => { process.env.SQLITE_PATH = env.file; return createStore(); });
await pgMigrationSuite('pg-mem');
await creationPathsSuite('sqlite', makeSqlite);
await creationPathsSuite('pg-mem', makePgMem);
await applySuite('sqlite', makeSqlite);
await applySuite('pg-mem', makePgMem);
globalThis.fetch = realFetch;
{
  const { store } = await makePgMem();
  ok('the second backend really is the PostgreSQL adapter (pg-mem)', store.kind === 'postgres');
}

/* ═════════════ part 4: source-level scope proofs ═════════════ */
{
  const applySrc = src('./seo/apply.js'), routesSrc = src('./seo/routes.js'), dbSrc = src('./db.js'), adminSrc = src('./admin/admin.js');
  const applyCode = strip(applySrc), routesCode = strip(routesSrc), dbCode = strip(dbSrc);
  const at = (s, needle) => s.indexOf(needle);
  const unchangedAt = at(applyCode, 'current.seo[rec.type] === value.seo[rec.type]'), staleAt = at(applyCode, 'rec.base_value != null'), casAt = at(applyCode, 'store.saveContentIfVersion(');
  ok('apply.js: the stale check sits AFTER the unchanged-success check and BEFORE the compare-and-swap', unchangedAt > 0 && staleAt > unchangedAt && casAt > staleAt);
  ok('apply.js: it compares the one field (current.seo[rec.type]) with rec.base_value, and the NULL base is "no guard" (!= null)', /if \(rec\.base_value != null && current\.seo\[rec\.type\] !== rec\.base_value\)/.test(applyCode));
  ok('apply.js: the refusal is { ok:false, stale:true, error } — not the conflict result, not the manual result', /return \{ ok: false, stale: true, error: /.test(applyCode) && !/conflict: true,[^}]*stale/.test(applyCode));
  ok('apply.js: still exactly one content read and one compare-and-swap, no loop, no retry; the crawled current_value is never read', (applyCode.match(/store\.getContent\(/g) || []).length === 1 && (applyCode.match(/saveContentIfVersion\(/g) || []).length === 1 && !/\b(for|while)\s*\(/.test(applyCode) && !/current_value|currentValue/.test(applyCode));
  const handler = routesCode.slice(routesCode.indexOf("router.post('/recommendations/:id/apply'"), routesCode.indexOf('return router;'));
  ok('routes.js: stale is recorded through the SAME single approved -> failed transition (still exactly four transition call sites) and answers 409 with reason, after the conflict branch', (routesCode.match(/store\.transitionRecommendation\(/g) || []).length === 4 && handler.indexOf('if (result.conflict)') > 0 && handler.indexOf('if (result.conflict)') < handler.indexOf("to: 'failed'") && handler.indexOf("to: 'failed'") < handler.indexOf('if (result.stale)') && /if \(result\.stale\) return res\.status\(409\)\.json\(\{ ok: false, reason: 'stale-value', error: result\.error, recommendation: failed \}\);/.test(handler) && handler.indexOf("error === 'manual implementation required'") < handler.indexOf('if (result.conflict)'));
  const create = dbCode.slice(dbCode.indexOf('async createRecommendation('), dbCode.indexOf('async getRecommendation('));
  ok('db.js: the base is captured inside createRecommendation, only for title/description, from the content row\'s own seo field — never from currentValue', /if \(type === 'title' \|\| type === 'description'\)/.test(create) && /\(await this\.getContent\(\)\)\?\.data\?\.seo\?\.\[type\]/.test(create) && /typeof live === 'string'/.test(create) && !/baseValue\s*=\s*currentValue/.test(create) && /base_value/.test(create));
  ok('db.js: the column is added with the existing additive addColumn convention, nullable TEXT (no NOT NULL, no DEFAULT), and nothing transactional was introduced', /await addColumn\('seo_recommendations', 'base_value', 'TEXT'\);/.test(dbCode) && !/BEGIN|COMMIT|ROLLBACK/.test(dbCode) && (dbSrc.match(/async saveContentIfVersion\(/g) || []).length === 1);
  for (const [file, label] of [['./seo/specialistRecommendationConverter.js', 'converter'], ['./seo/specialistIntegration.js', 'specialist integration'], ['./seo/recommendations.js', 'LLM recommendation module'], ['./seo/orchestrator.js', 'orchestrator'], ['./seo/jobs.js', 'scan jobs'], ['./seo/crawler.js', 'crawler']]) {
    ok(`scope: ${label} does not know about base_value (capture lives only in the shared store path)`, !/base_value|baseValue/.test(src(file)));
  }
  ok('admin.js: after a failed Apply with 409 or 422 the list is reloaded', /if \(x\.status === 409 \|\| x\.status === 422\) reload\(\);/.test(adminSrc));
  ok('admin.js: a failed card shows a neutral hint (cannot be applied; a fresh recommendation may be needed) and no new status was introduced', /rec\.status === 'failed' \? h\('p', \{ class: 'meta', text: 'This recommendation can no longer be applied\. A fresh recommendation may be needed/.test(adminSrc) && !/'stale'/.test(adminSrc));
  ok('admin.js: a 501 on a title/description recommendation gets target wording; every other type keeps the original "type needs to be implemented manually" message', /rec\.type === 'title' \|\| rec\.type === 'description'\s*\?\s*'This recommendation is not about this site\\'s home page/.test(adminSrc) && /: 'This recommendation type needs to be implemented manually — it cannot be applied automatically\.'/.test(adminSrc));
}

for (const st of opened) await st.close?.();
for (const f of dbFiles) for (const s of ['', '-wal', '-shm']) { try { rmSync(f + s, { force: true }); } catch { /* best effort: a leftover temp file is harmless */ } }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
