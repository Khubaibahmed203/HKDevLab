// Phase 4 Hardening #3 — content writes are compare-and-swap on an integer content version.
// Before this step every content writer (SEO Apply, the admin editor, Restore) did read -> modify -> write of the WHOLE document
// with no precondition, so a writer holding an out-of-date copy silently overwrote a newer save (and the editor's copy can be
// minutes old: it is loaded once and kept while the admin does something else, such as applying an SEO fix).
// Now the content row carries a version; saveContentIfVersion() updates only while the row is still at the version the caller read,
// and a stale writer changes nothing (no content write, no version change, no history row) and is told so — HTTP 409.
//
// The races are made deterministic with barriers/parking around the store's getContent() and saveContentIfVersion(): every writer is
// held until ALL of them have read the same version, and only then released — in a chosen order. (Plain concurrent calls on SQLite
// prove nothing: its driver is synchronous, so even unguarded code would look safe.)
// pg-mem validates the SQL and the affected-row count on the PostgreSQL adapter; it can NOT prove real PostgreSQL row-lock behavior.
// The HTTP-level scenarios (editor save, restore, bootstrap) run the real app on SQLite — createApp() cannot be pointed at pg-mem.
// Run: node server/test-content-concurrency.mjs
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { newDb } from 'pg-mem';
import { DatabaseSync } from 'node:sqlite';

const TMP = tmpdir();
const dbFiles = [];
const freshDbPath = (name) => { const f = join(TMP, `hk-content-concurrency-${name}.db`); for (const s of ['', '-wal', '-shm']) rmSync(f + s, { force: true }); dbFiles.push(f); return f; };
Object.assign(process.env, { SMTP_HOST: '', SETUP_TOKEN: '', GOOGLE_CLIENT_ID: '', NODE_ENV: 'development', CONTENT_TTL_MS: '100' });
delete process.env.DATABASE_URL;

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { (cond ? pass++ : fail++); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };

const { createStore } = await import(new URL('./db.js', import.meta.url).href);
const { applyRecommendation: applyBound } = await import(new URL('./seo/apply.js', import.meta.url).href);
const { createSeoRouter } = await import(new URL('./seo/routes.js', import.meta.url).href);
const { siteOrigin } = await import(new URL('../content/seo.js', import.meta.url).href);
// Since Hardening #11A, Apply only writes for a recommendation that belongs to the configured home website (and home page). This suite is about
// the content compare-and-swap, not the target, so its recommendations are given the home target; the binding itself is tested in test-seo-apply-target-binding.mjs.
const HOME_HOST = new URL(siteOrigin(process.env.PUBLIC_URL)).host;
const HOME_SITE = { id: 1, domain: HOME_HOST };
const applyRecommendation = (store, rec, opts) => applyBound(store, { website_id: HOME_SITE.id, page_id: null, ...rec }, { homeWebsite: HOME_SITE, ...opts });
const { DEFAULT_CONTENT } = await import(new URL('./content.js', import.meta.url).href);
const { createApp } = await import(new URL('./app.js', import.meta.url).href);
const src = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const clone = (o) => JSON.parse(JSON.stringify(o));
// documents are compared by content, not by key order (the editor GET fills sections from the defaults in a different key order than sanitizeContent writes them)
const canon = (o) => JSON.stringify(o, (k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v));
const doc = (title = 'Base Title', description = 'Base description', lede = 'Base lede') => { const d = clone(DEFAULT_CONTENT); d.seo.title = title; d.seo.description = description; d.hero.lede = lede; return d; };

/* ───────────── backends ───────────── */
let n = 0;
const opened = [];
async function makeSqlite() {
  const file = freshDbPath(`store${++n}`);
  process.env.SQLITE_PATH = file;
  const store = await createStore();
  opened.push(store);
  return { store, setVersionNull: async () => { const raw = new DatabaseSync(file); raw.exec("UPDATE content SET version = NULL WHERE key = 'site'"); raw.close(); }, rawVersion: async () => { const raw = new DatabaseSync(file); const v = raw.prepare("SELECT version FROM content WHERE key = 'site'").get()?.version; raw.close(); return v; } };
}
async function makePgMem() {
  const { Pool } = newDb().adapters.createPg();
  const pool = new Pool();
  const store = await createStore({ pool });
  return { store, setVersionNull: async () => { await pool.query("UPDATE content SET version = NULL WHERE key = 'site'"); }, rawVersion: async () => (await pool.query("SELECT version FROM content WHERE key = 'site'")).rows[0]?.version };
}
const newestHistoryId = async (store) => (await store.listVersions())[0]?.id ?? 0;
/** brings the row to exactly `target`, one successful compare-and-swap at a time */
async function toVersion(store, target, base = doc()) {
  await store.seedContentIfAbsent(base, 'seed@x.test', 'seed');
  let v = (await store.getContent()).version;
  for (let i = 0; i < target && v < target; i++) {            // bounded: a broken compare-and-swap must fail the assertions, not spin forever
    const r = await store.saveContentIfVersion({ ...base, hero: { ...base.hero, lede: `lede ${v + 1}` } }, 'seed@x.test', `seed ${v + 1}`, v);
    v = r.ok ? r.version : v;
  }
  if (v !== target) ok(`setup: the content could be brought to version ${target} (it is at ${v})`, false);
  return v;
}

/** Every writer's getContent() is held until `order.length` of them have read; their saves are then released strictly in `order`.
 *  Counts each writer's reads and compare-and-swap attempts, so "no automatic retry" is a measurable property. */
function gated(store, order) {
  let arrived = 0, release; const gate = new Promise((r) => (release = r));
  const turns = order.map(() => { let res; const p = new Promise((r) => (res = r)); return { p, res }; });
  const stats = Object.fromEntries(order.map((l) => [l, { reads: 0, saves: 0 }]));
  return {
    stats,
    view: (label) => ({
      ...store,
      getContent: async () => { const row = await store.getContent(); stats[label].reads += 1; if (stats[label].reads === 1) { arrived += 1; if (arrived === order.length) release(); await gate; } return row; },
      saveContentIfVersion: async (...a) => {
        const i = order.indexOf(label); stats[label].saves += 1;
        if (stats[label].saves === 1 && i > 0) await turns[i - 1].p;
        try { return await store.saveContentIfVersion(...a); } finally { if (stats[label].saves === 1) turns[i].res(); }
      },
    }),
  };
}

/** Holds the first `parties` reads of getContent() until all of them have arrived (so every racing request has read the same version),
 *  then lets them go together. Later reads pass straight through. The winner is then decided by the compare-and-swap alone. */
function withReadBarrier(base, parties) {
  let seen = 0, arrived = 0, release; const gate = new Promise((r) => (release = r));
  return { ...base, getContent: async () => {
    const row = await base.getContent();
    if (seen < parties) { seen += 1; arrived += 1; if (arrived === parties) release(); await gate; }
    return row;
  } };
}

/* ═════════════════════════ part 1: the store and the SEO apply, on SQLite and on the PostgreSQL adapter ═════════════════════════ */
async function suite(label, make) {
  const T = (name) => `[${label}] ${name}`;

  /* A. CAS success */
  {
    const { store } = await make();
    const v = await toVersion(store, 10);
    const hBefore = await newestHistoryId(store);
    const next = doc('Title written at V10', 'Description at V10');
    const r = await store.saveContentIfVersion(next, 'writer@x.test', 'a note', 10);
    const row = await store.getContent();
    ok(T('A. CAS success: a writer that read version 10 saves and gets { ok: true, version: 11 }'), v === 10 && r.ok === true && r.version === 11 && typeof r.updatedAt === 'string', JSON.stringify(r));
    ok(T('A. …the stored content, version, author and time are exactly what was written'), JSON.stringify(row.data) === JSON.stringify(next) && row.version === 11 && row.updatedBy === 'writer@x.test' && row.updatedAt === r.updatedAt, JSON.stringify(row).slice(0, 160));
    const hist = await store.listVersions();
    ok(T('A. …and exactly one history entry was added for it, after the write, carrying the note'), (await newestHistoryId(store)) === hBefore + 1 && hist[0].note === 'a note' && hist[0].user_email === 'writer@x.test');
    ok(T('A. …the history snapshot is the document that went live'), JSON.stringify(await store.getVersion(hist[0].id)) === JSON.stringify(next));
  }

  /* B. stale writer */
  {
    const { store } = await make();
    await toVersion(store, 11);
    const a = doc('Writer A title'), b = doc('Writer B title');
    const ra = await store.saveContentIfVersion(a, 'a@x.test', 'A', 11);
    const afterA = await store.getContent(), hAfterA = await newestHistoryId(store), countAfterA = (await store.listVersions()).length;
    const rb = await store.saveContentIfVersion(b, 'b@x.test', 'B', 11);
    const afterB = await store.getContent();
    ok(T('B. stale writer: A (expected 11) wins and moves the row to 12'), ra.ok === true && ra.version === 12 && afterA.version === 12);
    ok(T('B. …B, still expecting 11, gets a conflict (not ok, not a success)'), rb.ok === false && rb.conflict === true && rb.version === undefined, JSON.stringify(rb));
    ok(T('B. …content, version, author and time are exactly A\'s — B changed nothing'), JSON.stringify(afterB) === JSON.stringify(afterA) && afterB.version === 12 && afterB.updatedBy === 'a@x.test' && afterB.data.seo.title === 'Writer A title');
    ok(T('B. …and B added no history row'), (await newestHistoryId(store)) === hAfterA && (await store.listVersions()).length === countAfterA);
  }

  /* H. normal sequential saves */
  {
    const { store } = await make();
    await toVersion(store, 10);
    const steps = [];
    for (const expected of [10, 11, 12]) steps.push(await store.saveContentIfVersion(doc(`Title at ${expected}`), 'seq@x.test', `s${expected}`, expected));
    ok(T('H. sequential saves: version 10 -> 11 -> 12 -> 13, every one succeeds with the next version'), steps.map((s) => s.ok && s.version).join() === '11,12,13', JSON.stringify(steps));
    ok(T('H. …and the final content is the last write'), (await store.getContent()).data.seo.title === 'Title at 12' && (await store.getContent()).version === 13);
  }

  /* K. a failed CAS changes nothing (stale, future and invalid tokens) */
  {
    const { store } = await make();
    await toVersion(store, 7);
    const snapshot = JSON.stringify(await store.getContent()), hBefore = await newestHistoryId(store), cBefore = (await store.listVersions()).length;
    const attempts = {};
    for (const [name, expected] of [['stale (6)', 6], ['stale (0)', 0], ['a version from the future (8)', 8], ['a version from the future (99)', 99]]) attempts[name] = await store.saveContentIfVersion(doc('MUST NOT BE WRITTEN'), 'late@x.test', 'late', expected);
    ok(T('K. failed CAS: every stale or future token affects 0 rows and returns a conflict'), Object.values(attempts).every((r) => r.ok === false && r.conflict === true), JSON.stringify(attempts));
    ok(T('K. …the row (content, version, author, time) is byte-for-byte unchanged'), JSON.stringify(await store.getContent()) === snapshot);
    ok(T('K. …and no history row was inserted by any of the failed attempts'), (await newestHistoryId(store)) === hBefore && (await store.listVersions()).length === cBefore);
    const bad = [];
    for (const v of [undefined, null, '7', 7.5, -1, NaN, {}]) { let threw = false; try { await store.saveContentIfVersion(doc('MUST NOT BE WRITTEN'), 'x@x.test', 'x', v); } catch { threw = true; } if (!threw) bad.push(String(v)); }
    ok(T('K. a missing or malformed expected version is refused before any SQL runs (7 bad values)'), bad.length === 0 && JSON.stringify(await store.getContent()) === snapshot && (await newestHistoryId(store)) === hBefore, bad.join());
  }

  /* I. legacy NULL version */
  {
    const { store, setVersionNull, rawVersion } = await make();
    await toVersion(store, 3);
    await setVersionNull();
    ok(T('I. a content row whose version column is NULL really is NULL at the storage level'), (await rawVersion()) == null);
    ok(T('I. …and the application reads it as version 0'), (await store.getContent()).version === 0);
    const stale = await store.saveContentIfVersion(doc('MUST NOT BE WRITTEN'), 'x@x.test', 'x', 3);
    ok(T('I. …so a writer expecting a nonzero version is refused'), stale.ok === false && (await store.getContent()).data.seo.title !== 'MUST NOT BE WRITTEN');
    const fresh = await store.saveContentIfVersion(doc('Written over NULL'), 'x@x.test', 'x', 0);
    ok(T('I. …and a writer that read 0 succeeds, moving the row to version 1'), fresh.ok === true && fresh.version === 1 && (await store.getContent()).version === 1 && Number(await rawVersion()) === 1);
    const again = await store.saveContentIfVersion(doc('Second'), 'x@x.test', 'x', 0);
    ok(T('I. …and then expecting 0 again is stale'), again.ok === false && (await store.getContent()).data.seo.title === 'Written over NULL');
    await setVersionNull();
    await store.saveContent(doc('Legacy unconditional save'), 'legacy@x.test', 'legacy');
    ok(T('I. the legacy unconditional saveContent() on a NULL row also advances it (to 1), so older tokens are refused'), (await store.getContent()).version === 1);
  }

  /* absent row + bootstrap */
  {
    const { store, rawVersion } = await make();
    ok(T('R. a store with no content yet reads null'), (await store.getContent()) === null);
    const lateStale = await store.saveContentIfVersion(doc('MUST NOT BE WRITTEN'), 'x@x.test', 'x', 5);
    ok(T('R. a stale token against a missing row creates nothing'), lateStale.ok === false && (await store.getContent()) === null && (await store.listVersions()).length === 0);
    const first = await store.saveContentIfVersion(doc('First ever'), 'x@x.test', 'first', 0);
    ok(T('R. version 0 against a missing row creates it, at version 1, with a history entry'), first.ok === true && first.version === 1 && (await store.getContent()).version === 1 && (await store.listVersions()).length === 1);
    const second = await store.saveContentIfVersion(doc('Overwrites?'), 'x@x.test', 'second', 0);
    ok(T('R. …and version 0 again no longer matches the existing row: the creation path never overwrites it'), second.ok === false && (await store.getContent()).data.seo.title === 'First ever');
  }
  {
    const { store } = await make();
    const hBefore = await newestHistoryId(store);
    const created = await store.seedContentIfAbsent(doc('Seeded'), 'system', 'Initial content');
    const row = await store.getContent();
    ok(T('R. bootstrap seeding creates the row at version 0 with one history entry'), created === true && row.version === 0 && row.data.seo.title === 'Seeded' && row.updatedBy === 'system' && (await newestHistoryId(store)) === hBefore + 1);
    const again = await store.seedContentIfAbsent(doc('Seeded again'), 'system', 'Initial content');
    ok(T('R. …seeding a second time does nothing (false), changes no content and adds no history row'), again === false && JSON.stringify(await store.getContent()) === JSON.stringify(row) && (await newestHistoryId(store)) === hBefore + 1);
    await store.saveContentIfVersion(doc('Edited by a person'), 'ed@x.test', 'edit', 0);
    ok(T('R. …and seeding after real content exists can never replace it'), (await store.seedContentIfAbsent(DEFAULT_CONTENT, 'system', 'Initial content')) === false && (await store.getContent()).data.seo.title === 'Edited by a person');
  }
  {
    const { store } = await make();
    const outcomes = await Promise.all([store.seedContentIfAbsent(doc('Seed one'), 'system', 'Initial content'), store.seedContentIfAbsent(doc('Seed two'), 'system', 'Initial content')]);
    ok(T('R. two simultaneous first starts: exactly one creates the row, and there is exactly one history entry'), outcomes.filter(Boolean).length === 1 && (await store.listVersions()).length === 1, JSON.stringify(outcomes));
  }

  /* C. Apply vs Apply (different recommendations, different fields), both write orders */
  for (const order of [['A', 'B'], ['B', 'A']]) {
    const { store } = await make();
    const base = doc('Base Title', 'Base description');
    await toVersion(store, 10, base);
    const baseRow = await store.getContent();
    const recs = { A: { id: 101, type: 'title', proposed_value: 'SEO Title (A)' }, B: { id: 102, type: 'description', proposed_value: 'SEO description (B)' } };
    const field = { A: 'title', B: 'description' };
    const g = gated(store, order);
    const hBefore = await newestHistoryId(store);
    const results = Object.fromEntries(await Promise.all(order.map(async (l) => [l, await applyRecommendation(g.view(l), recs[l], { userEmail: `${l}@x.test` })])));
    const [first, second] = order, row = await store.getContent();
    const tag = `${label} order ${order.join('->')}`;
    ok(`[${tag}] C. Apply || Apply (title vs description, both read version 10): the first writer succeeds, the second gets a conflict`, results[first].ok === true && results[second].ok === false && results[second].conflict === true, JSON.stringify(results));
    ok(`[${tag}] C. …no silent loss: the winner's field is live, and the loser's field is still the base value (not a half-merged or overwritten document)`, row.data.seo[field[first]] === recs[first].proposed_value && row.data.seo[field[second]] === baseRow.data.seo[field[second]], JSON.stringify(row.data.seo));
    ok(`[${tag}] C. …the version moved exactly once (10 -> 11) and exactly one history entry was written, by the winner`, row.version === 11 && (await newestHistoryId(store)) === hBefore + 1 && (await store.listVersions())[0].note === `Applied AI SEO recommendation #${recs[first].id}`);
    ok(`[${tag}] C. …no automatic retry: the loser read the content once and attempted the write once`, g.stats[second].reads === 1 && g.stats[second].saves === 1, JSON.stringify(g.stats));
    const retried = await applyRecommendation(store, recs[second], { userEmail: `${second}@x.test` });
    const final = await store.getContent();
    ok(`[${tag}] C. …the stale loser can be re-reviewed and applied again against the new content: both fields end up live, version 12`, retried.ok === true && final.data.seo.title === 'SEO Title (A)' && final.data.seo.description === 'SEO description (B)' && final.version === 12, JSON.stringify(final.data.seo));
  }

  /* C2. the SAME recommendation applied twice at once — Hardening #2 left this as a known limitation (two identical content writes) */
  {
    const { store } = await make();
    await toVersion(store, 6, doc('Base Title', 'Base description'));
    const rec = { id: 201, type: 'title', proposed_value: 'Same Recommendation Title' };
    const g = gated(store, ['A', 'B']), hBefore = await newestHistoryId(store);
    const [ra, rb] = await Promise.all([applyRecommendation(g.view('A'), rec, { userEmail: 'a@x.test' }), applyRecommendation(g.view('B'), rec, { userEmail: 'b@x.test' })]);
    const row = await store.getContent();
    ok(T('C2. the same recommendation applied twice on the same version: one succeeds, the other is refused as a conflict'), ra.ok === true && rb.ok === false && rb.conflict === true, JSON.stringify([ra, rb]));
    ok(T('C2. …so there is exactly ONE content write: one version step (6 -> 7), one history entry, the value live'), row.version === 7 && (await newestHistoryId(store)) === hBefore + 1 && row.data.seo.title === 'Same Recommendation Title');
  }

  /* J. idempotency of the SEO content write */
  {
    const { store } = await make();
    await toVersion(store, 4, doc('Already Live Title', 'Live description'));
    const snapshot = JSON.stringify(await store.getContent()), hBefore = await newestHistoryId(store);
    const same = await applyRecommendation(store, { id: 7, type: 'title', proposed_value: 'Already Live Title' }, { userEmail: 'a@x.test' });
    ok(T('J. the proposed title is already live: applying it is a no-op that reports success'), same.ok === true && same.unchanged === true, JSON.stringify(same));
    ok(T('J. …no content write (row untouched incl. time and version) and no duplicate history row'), JSON.stringify(await store.getContent()) === snapshot && (await newestHistoryId(store)) === hBefore);
    const spaced = await applyRecommendation(store, { id: 8, type: 'title', proposed_value: '  Already Live Title  ' }, { userEmail: 'a@x.test' });
    ok(T('J. …"already live" is judged on the sanitized value, so stray whitespace around the same title is still a no-op'), spaced.ok === true && spaced.unchanged === true && JSON.stringify(await store.getContent()) === snapshot);
    const crossType = await applyRecommendation(store, { id: 9, type: 'title', proposed_value: 'Live description' }, { userEmail: 'a@x.test' });
    const afterCross = await store.getContent();
    ok(T('J. not a generic equality shortcut: proposing the value that happens to be live in a DIFFERENT field is a real write'), crossType.ok === true && crossType.unchanged === undefined && afterCross.data.seo.title === 'Live description' && afterCross.version === 5 && (await newestHistoryId(store)) === hBefore + 1);
    const differs = await applyRecommendation(store, { id: 10, type: 'description', current_value: 'what the crawler saw', proposed_value: 'A brand new description' }, { userEmail: 'a@x.test' });
    const afterDiffers = await store.getContent();
    ok(T('J. a live value that differs from the proposal (and from current_value) is written normally under the version check — never skipped'), differs.ok === true && afterDiffers.data.seo.description === 'A brand new description' && afterDiffers.version === 6);
  }

  /* P. validation and unsupported types keep their semantics, and never touch the content */
  {
    const { store } = await make();
    await toVersion(store, 2);
    const snapshot = JSON.stringify(await store.getContent());
    const invalid = await applyRecommendation(store, { id: 11, type: 'title', proposed_value: 'A'.repeat(200) }, { userEmail: 'a@x.test' });
    const manual = await applyRecommendation(store, { id: 12, type: 'heading', proposed_value: 'x' }, { userEmail: 'a@x.test' });
    ok(T('P. an invalid proposal is still a validation failure (not a conflict) and writes nothing'), invalid.ok === false && invalid.conflict === undefined && /validation/.test(invalid.error) && Array.isArray(invalid.details));
    ok(T('P. an unsupported type is still "manual implementation required" (the route maps it to 501) and writes nothing'), manual.ok === false && manual.error === 'manual implementation required' && manual.conflict === undefined && JSON.stringify(await store.getContent()) === snapshot);
  }
}

await suite('sqlite', makeSqlite);
await suite('pg-mem', makePgMem);
{
  const { store } = await makePgMem();
  ok('the second backend really is the PostgreSQL adapter (pg-mem)', store.kind === 'postgres');
}

/* ═════════════ part 2: the SEO Apply HTTP route on both backends (mini app, stand-in session) — conflict semantics ═════════════ */
async function seoRouteSuite(label, make) {
  const T = (name) => `[${label}] ${name}`;
  const { store } = await make();
  const site = await store.ensureWebsite(HOME_HOST, label);   // the configured home website: Apply is bound to it (Hardening #11A)
  const audit = await store.createAudit(site.id, { baseUrl: 'http://127.0.0.1:9', pagesPlanned: 1, status: 'running' });
  await store.createIssues(site.id, audit.id, [{ pageId: null, type: 'title-length', severity: 'warning', detail: 'x' }]);
  const issue = (await store.listIssues({ websiteId: site.id, auditId: audit.id }))[0];
  const approved = async ({ type = 'title', value = 'A Perfectly Fine New Title' } = {}) => {
    const rec = await store.createRecommendation({ websiteId: site.id, issueId: issue.id, pageId: null, type, currentValue: 'Old', proposedValue: value, reasoning: 'r', aiProvider: 'test', aiModel: 'test' });
    await store.setRecommendationStatus(rec.id, 'approved', { reviewedBy: 'seed@x.test' });
    return store.getRecommendation(rec.id);
  };
  const serve = (viewStore) => new Promise((resolve) => {
    const app = express(); app.use(express.json());
    app.use((req, res, next) => { req.user = { id: 1, email: 'actor@x.test' }; next(); });
    app.use('/api/admin/seo', createSeoRouter(viewStore, { limiter: { take: async () => false } }));
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const stop = (s) => { s.closeAllConnections?.(); s.close(); };
  const apply = async (s, id) => { const r = await fetch(`http://127.0.0.1:${s.address().port}/api/admin/seo/recommendations/${id}/apply`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); return { status: r.status, body: await r.json().catch(() => ({})) }; };

  await toVersion(store, 5, doc('Base Title', 'Base description'));

  // two different approved recommendations applied through the real route, both holding the same version
  const recT = await approved({ type: 'title', value: 'SEO Title (route)' }), recD = await approved({ type: 'description', value: 'SEO description (route)' });
  const barrier = withReadBarrier(store, 2);
  const server = await serve(barrier);
  const hBefore = await newestHistoryId(store);
  const [ra, rb] = await Promise.all([apply(server, recT.id), apply(server, recD.id)]);
  stop(server);
  const codes = [ra.status, rb.status].sort().join();
  const [winner, loser] = ra.status === 200 ? [ra, rb] : [rb, ra], loserRec = ra.status === 200 ? recD : recT;
  const after = await store.getContent();
  ok(T('route: two applies of different recommendations on the same version -> exactly one 200 and one 409'), codes === '200,409', JSON.stringify([ra.status, rb.status]));
  ok(T('route: …the loser\'s 409 says the content changed and that nothing was written, with the recommendation still approved'), loser.status === 409 && loser.body.ok === false && /content changed/.test(loser.body.error) && /nothing was written/.test(loser.body.error) && loser.body.recommendation?.status === 'approved', JSON.stringify(loser.body).slice(0, 200));
  const loserNow = await store.getRecommendation(loserRec.id), winnerRec = ra.status === 200 ? recT : recD;
  ok(T('route: …the loser is left approved — not failed, not applied — with no applied_at'), loserNow.status === 'approved' && loserNow.applied_at === null && loserNow.reviewed_by === 'seed@x.test');
  ok(T('route: …the winner is applied (the approved -> applied guard from Hardening #2 still runs after the content write)'), (await store.getRecommendation(winnerRec.id)).status === 'applied' && winner.body.recommendation?.status === 'applied');
  ok(T('route: …one content write: version 5 -> 6, one history entry, and only the winner\'s field changed'), after.version === 6 && (await newestHistoryId(store)) === hBefore + 1 && (after.data.seo.title === 'SEO Title (route)') !== (after.data.seo.description === 'SEO description (route)'));

  // the loser retried by a person against the new content
  const retryServer = await serve(store);
  const retry = await apply(retryServer, loserRec.id);
  const merged = await store.getContent();
  ok(T('route: the stale recommendation, re-applied on purpose, succeeds and both fields are live (version 7)'), retry.status === 200 && merged.version === 7 && merged.data.seo.title === 'SEO Title (route)' && merged.data.seo.description === 'SEO description (route)', `${retry.status} ${JSON.stringify(merged.data.seo)}`);

  // idempotency: crash after the content write, before the status write, then retry
  const crashRec = await approved({ type: 'title', value: 'Crash Retry Title' });
  let crashed = false;
  const crashStore = { ...store, transitionRecommendation: async (id, o) => { if (!crashed && o.to === 'applied') { crashed = true; throw new Error('simulated crash after the content write'); } return store.transitionRecommendation(id, o); } };
  const crashServer = await serve(crashStore);
  const realError = console.error; console.error = () => {};
  const hCrash = await newestHistoryId(store);
  const first = await apply(crashServer, crashRec.id);
  console.error = realError;
  const mid = { rec: (await store.getRecommendation(crashRec.id)).status, version: (await store.getContent()).version, hist: await newestHistoryId(store) };
  const second = await apply(crashServer, crashRec.id);
  stop(crashServer); stop(retryServer);
  const done = { rec: (await store.getRecommendation(crashRec.id)).status, version: (await store.getContent()).version, hist: await newestHistoryId(store) };
  ok(T('route: crash after the content write -> the first request fails (500) and the recommendation is still approved, with the content already live'), first.status === 500 && mid.rec === 'approved' && (await store.getContent()).data.seo.title === 'Crash Retry Title' && mid.hist === hCrash + 1);
  ok(T('route: …the retry succeeds (200), the recommendation becomes applied, and it wrote NOTHING again: same version, no duplicate history row'), second.status === 200 && done.rec === 'applied' && done.version === mid.version && done.hist === mid.hist, JSON.stringify([second.status, mid, done]));

  // existing semantics still hold next to the version check
  const srv = await serve(store);
  const manual = await apply(srv, (await approved({ type: 'heading', value: 'x' })).id);
  const invalidRec = await approved({ type: 'title', value: 'A'.repeat(200) });
  const invalid = await apply(srv, invalidRec.id);
  stop(srv);
  ok(T('route: unsupported type -> 501 and stays approved (unchanged)'), manual.status === 501 && manual.body.recommendation?.status === 'approved');
  ok(T('route: validation failure -> 422 and recorded as failed (unchanged), content untouched'), invalid.status === 422 && (await store.getRecommendation(invalidRec.id)).status === 'failed');
}
await seoRouteSuite('sqlite', makeSqlite);
await seoRouteSuite('pg-mem', makePgMem);

/* ═════════════ part 3: the real app over HTTP (SQLite) — editor, restore, bootstrap, SEO apply sharing one protocol ═════════════ */
const APP_DB = freshDbPath('app');
process.env.SQLITE_PATH = APP_DB;
const { app, store } = await createApp();
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
const bootRow = await store.getContent(), bootHistory = await store.listVersions();   // what the first start left behind
let cookie = '';
async function call(method, path, json) {
  const h = { 'X-Requested-With': 'hk-admin' };
  if (json !== undefined) h['Content-Type'] = 'application/json';
  if (cookie) h.Cookie = cookie;
  const res = await fetch(base + path, { method, headers: h, body: json !== undefined ? JSON.stringify(json) : undefined });
  for (const c of res.headers.getSetCookie?.() || []) { const [kv] = c.split(';'); const [k, v] = kv.split('='); cookie = v === '' ? '' : `${k}=${v}`; }
  let data = {}; try { data = await res.json(); } catch { /* not JSON */ }
  return { status: res.status, data };
}
const get = async () => (await call('GET', '/api/admin/content')).data;
const put = (content, version) => call('PUT', '/api/admin/content', { content, version });
const apply = (id) => call('POST', `/api/admin/seo/recommendations/${id}/apply`);

const setup = await call('POST', '/api/auth/setup', { name: 'Test Admin', email: 'cas-test@example.com', password: 'a-long-test-password-1' });
ok('setup: the test admin exists', setup.status === 201, JSON.stringify(setup.data));

const site = await store.ensureWebsite(HOME_HOST, 'cas');   // the configured home website: Apply is bound to it (Hardening #11A)
const audit = await store.createAudit(site.id, { baseUrl: 'http://127.0.0.1:9', pagesPlanned: 1, status: 'running' });
await store.createIssues(site.id, audit.id, [{ pageId: null, type: 'title-length', severity: 'warning', detail: 'x' }]);
const issue = (await store.listIssues({ websiteId: site.id, auditId: audit.id }))[0];
async function approvedRec(type, value) {
  const rec = await store.createRecommendation({ websiteId: site.id, issueId: issue.id, pageId: null, type, currentValue: 'Old', proposedValue: value, reasoning: 'r', aiProvider: 'test', aiModel: 'test' });
  await store.setRecommendationStatus(rec.id, 'approved', { reviewedBy: 'seed@x.test' });
  return rec.id;
}
/** Parks the next `n` getContent() reads (whoever makes them) until released — used right before firing one request, so the parked read is that request's. */
function parkNextReads(n) {
  const real = store.getContent;
  let remaining = n, arrived = 0, release, onAll;
  const gate = new Promise((r) => (release = r)), allParked = new Promise((r) => (onAll = r));
  store.getContent = async function (...a) {
    const row = await real.apply(this, a);
    if (remaining > 0) { remaining -= 1; arrived += 1; if (arrived === n) onAll(); await gate; }
    return row;
  };
  return { parked: () => allParked, release: () => { release(); store.getContent = real; } };
}
const rateReset = () => store.rateClear('seo-apply:1');

/* L. the editor protocol */
{
  const first = await get();
  ok('editor GET returns the content together with its version (the seeded bootstrap document is version 0)', first.version === 0 && first.content?.hero?.chips?.length === 4 && first.updatedBy === 'system', JSON.stringify({ v: first.version, by: first.updatedBy }));
  const snapshot = JSON.stringify(await store.getContent()), h0 = await newestHistoryId(store);
  const edit = clone(first.content); edit.hero.lede = 'WOULD HAVE BYPASSED THE CHECK';
  const rejects = [];
  for (const [name, body] of [['no version at all', { content: edit }], ['version null', { content: edit, version: null }], ['a string version', { content: edit, version: '0' }], ['a fractional version', { content: edit, version: 0.5 }], ['a negative version', { content: edit, version: -1 }]]) {
    const r = await call('PUT', '/api/admin/content', body);
    if (r.status !== 400 || r.data.ok !== false) rejects.push(`${name}: ${r.status}`);
  }
  ok('editor PUT: the version is REQUIRED — a missing, null, string, fractional or negative version is refused (400) and cannot bypass the check', rejects.length === 0, rejects.join('; '));
  ok('…and every refused attempt changed nothing: no content write, same version, no history row', JSON.stringify(await store.getContent()) === snapshot && (await newestHistoryId(store)) === h0);

  const saved = await put(edit, first.version);
  ok('editor PUT with the correct version succeeds (200) and returns the NEXT version (exactly +1) with the saved content', saved.status === 200 && saved.data.ok === true && saved.data.version === first.version + 1 && saved.data.content.hero.lede === edit.hero.lede && saved.data.updatedBy === 'cas-test@example.com', JSON.stringify(saved.data).slice(0, 160));
  const reread = await get();
  ok('…a fresh GET reports that same version and content', reread.version === saved.data.version && reread.content.hero.lede === edit.hero.lede && (await newestHistoryId(store)) === h0 + 1);

  // H. sequential saves keep working through the editor, each carrying the version the previous one returned
  let v = reread.version, okAll = true;
  for (let i = 0; i < 3; i++) { const e = clone(reread.content); e.hero.lede = `sequential ${i}`; const r = await put(e, v); okAll = okAll && r.status === 200 && r.data.version === v + 1; v = r.data.version; }
  ok('H. normal sequential editor saves, each using the version returned by the previous one, all succeed', okAll && (await get()).version === v);
}

/* E. editor vs editor */
for (const winnerFirst of ['one', 'two']) {
  const cur = await get();
  const s1 = clone(cur.content), s2 = clone(cur.content);
  s1.hero.lede = `editor one (${winnerFirst})`; s2.hero.eyebrow = `editor two (${winnerFirst})`;
  const [firstDoc, secondDoc] = winnerFirst === 'one' ? [s1, s2] : [s2, s1];
  const h0 = await newestHistoryId(store);
  const r1 = await put(firstDoc, cur.version), r2 = await put(secondDoc, cur.version);
  const final = await get();
  ok(`E. editor vs editor (two copies of version ${cur.version}, editor ${winnerFirst} saves first): the first save wins, the second is refused with 409`, r1.status === 200 && r2.status === 409 && r2.data.ok === false && /after you opened it/.test(r2.data.error) && /nothing was saved/.test(r2.data.error), `${r1.status} ${r2.status} ${JSON.stringify(r2.data)}`);
  ok(`E. …only the first editor's change is live, the version moved once, and the loser added no history row`, canon(final.content) === canon(r1.data.content) && final.version === cur.version + 1 && (await newestHistoryId(store)) === h0 + 1);
}
{
  const cur = await get();
  const a = clone(cur.content), b = clone(cur.content); a.hero.lede = 'simultaneous A'; b.hero.lede = 'simultaneous B';
  const rs = await Promise.all([put(a, cur.version), put(b, cur.version)]);
  const final = await get();
  ok('E. two simultaneous editor saves of the same version: exactly one 200 and one 409, and the version moved once', rs.map((r) => r.status).sort().join() === '200,409' && final.version === cur.version + 1, JSON.stringify(rs.map((r) => r.status)));
}

/* D / F. editor vs SEO Apply, through the real routes */
{
  // D1: both read the same version; the SEO apply writes first, then the (now stale) editor saves
  await rateReset();
  const rec = await approvedRec('title', 'SEO Title D1');
  const cur = await get(), editorCopy = clone(cur.content); editorCopy.hero.lede = 'editor lede D1';
  const park = parkNextReads(1);
  const applyP = apply(rec);
  await park.parked();                                            // the apply has read the content (version v) and is parked
  const editorGot = await get();                                  // the editor reads the very same version
  park.release();
  const ap = await applyP;
  const h1 = await newestHistoryId(store);
  const stale = await put(editorCopy, editorGot.version);
  const after = await get();
  ok('D. editor vs SEO apply, both read version v, APPLY writes first: apply 200 (v+1), then the stale editor save is refused with 409', editorGot.version === cur.version && ap.status === 200 && stale.status === 409, `${ap.status} ${stale.status}`);
  ok('D. …the SEO change stays live, the editor\'s stale copy did not overwrite it, version v+1, and the refused save added no history row', after.content.seo.title === 'SEO Title D1' && after.content.hero.lede !== 'editor lede D1' && after.version === cur.version + 1 && (await newestHistoryId(store)) === h1);

  // D2: the editor saves first, then the stale SEO apply tries to write
  await rateReset();
  const rec2 = await approvedRec('description', 'SEO description D2');
  const cur2 = await get(), editorCopy2 = clone(cur2.content); editorCopy2.hero.lede = 'editor lede D2';
  const park2 = parkNextReads(1);
  const applyP2 = apply(rec2);
  await park2.parked();                                           // the apply has read version v2 and is parked
  const editorSave = await put(editorCopy2, cur2.version);
  park2.release();
  const ap2 = await applyP2;
  const after2 = await get(), recAfter = await store.getRecommendation(rec2);
  ok('D. editor vs SEO apply, both read version v, EDITOR writes first: editor 200, then the stale SEO apply is refused with 409', editorSave.status === 200 && ap2.status === 409 && ap2.data.ok === false, `${editorSave.status} ${ap2.status}`);
  ok('D. …the editor\'s change is live and the SEO value is NOT (no silent overwrite either way); version moved once', after2.content.hero.lede === 'editor lede D2' && after2.content.seo.description !== 'SEO description D2' && after2.version === cur2.version + 1);
  ok('D. …the stale recommendation remains approved (not failed, not applied), with no applied_at, and the 409 says to review/retry', recAfter.status === 'approved' && recAfter.applied_at === null && /content changed/.test(ap2.data.error) && /apply it again/.test(ap2.data.error) && ap2.data.recommendation?.status === 'approved', JSON.stringify(ap2.data).slice(0, 200));
  await rateReset();
  const retried = await apply(rec2);
  const after2b = await get();
  ok('D. …and applying it again on purpose (a fresh read) succeeds without disturbing the editor\'s change', retried.status === 200 && after2b.content.seo.description === 'SEO description D2' && after2b.content.hero.lede === 'editor lede D2');
}
{
  // F. the audit's headline bug, strictly sequential: editor loads, SEO fix applied, editor saves the old copy
  await rateReset();
  const loaded = await get();                                     // the editor opens "Site content" (draft kept in the page)
  const rec = await approvedRec('title', 'SEO Title F');
  const ap = await apply(rec);                                    // the admin applies it on the SEO tab
  const liveAfterApply = await get();
  const h1 = await newestHistoryId(store);
  const draft = clone(loaded.content); draft.hero.lede = 'edit made on a stale draft';
  const stale = await put(draft, loaded.version);                 // …and later saves the stale draft
  const live = await get();
  ok('F. stale editor after SEO apply: editor GET (v) -> apply (v+1) -> editor PUT with v is refused with 409', ap.status === 200 && liveAfterApply.version === loaded.version + 1 && stale.status === 409, `${ap.status} ${stale.status}`);
  ok('F. …the applied SEO title is still live (the stale draft did NOT overwrite it), version unchanged by the refused save, no history row added', live.content.seo.title === 'SEO Title F' && live.content.hero.lede !== 'edit made on a stale draft' && live.version === liveAfterApply.version && (await newestHistoryId(store)) === h1);
  ok('F. …the recommendation is still applied', (await store.getRecommendation(rec)).status === 'applied');
  const redo = clone(live.content); redo.hero.lede = 'edit made after reloading';
  const recovered = await put(redo, live.version);
  const final = await get();
  ok('F. after reloading (a fresh GET) the same edit saves, and both the SEO title and the edit are live', recovered.status === 200 && final.content.seo.title === 'SEO Title F' && final.content.hero.lede === 'edit made after reloading');
}

/* G. restore */
{
  const versions = await store.listVersions();
  const target = versions[Math.min(3, versions.length - 1)];
  const before = await get();
  const editorHoldingOld = clone(before.content); editorHoldingOld.hero.lede = 'saved by an editor holding the pre-restore copy';
  const h0 = await newestHistoryId(store);
  const restored = await call('POST', `/api/admin/content/restore/${target.id}`);
  const after = await get();
  ok('G. restore succeeds (200), and the version advances by exactly one (v -> v+1) — it is reported to the editor too', restored.status === 200 && restored.data.ok === true && restored.data.version === before.version + 1 && after.version === before.version + 1, JSON.stringify(restored.data).slice(0, 120));
  ok('G. …the restored document is live, it is recorded in the history as a restore, exactly one entry was added', canon(after.content) === canon(restored.data.content) && (await newestHistoryId(store)) === h0 + 1 && (await store.listVersions())[0].note === `Restored version #${target.id}`);
  const hAfterRestore = await newestHistoryId(store);
  const stale = await put(editorHoldingOld, before.version);
  ok('G. an editor still holding the pre-restore version is refused (409) — the old token is dead after a restore', stale.status === 409, String(stale.status));
  const afterStale = await get();
  ok('G. …and the restored content stays live, version unchanged, no history row from the refused save', canon(afterStale.content) === canon(after.content) && afterStale.version === after.version && (await newestHistoryId(store)) === hAfterRestore);

  // an SEO apply that read the content before the restore is refused too: editor, restore and SEO apply all share the one version
  await rateReset();
  const recG = await approvedRec('title', 'SEO Title G');
  const curG = await get();
  const parkG = parkNextReads(1);
  const applyG = apply(recG);
  await parkG.parked();
  const restoredAgain = await call('POST', `/api/admin/content/restore/${target.id}`);
  parkG.release();
  const apG = await applyG;
  const afterG = await get();
  ok('G. SEO apply vs restore: an apply that read version v before a restore (v+1) is refused (409) and stays approved; the restored content is not overwritten', restoredAgain.status === 200 && apG.status === 409 && (await store.getRecommendation(recG)).status === 'approved' && afterG.content.seo.title !== 'SEO Title G' && afterG.version === curG.version + 1, `${restoredAgain.status} ${apG.status}`);

  // restore racing a save: the restore reads the CURRENT version itself, so a save landing in between makes the restore refuse rather than overwrite it
  const cur = await get(), racer = clone(cur.content); racer.hero.lede = 'saved while a restore was in flight';
  const hBeforeRace = await newestHistoryId(store);
  const park = parkNextReads(1);
  const restoreP = call('POST', `/api/admin/content/restore/${target.id}`);
  await park.parked();
  const racerSave = await put(racer, cur.version);
  park.release();
  const lost = await restoreP;
  const post = await get();
  ok('G. restore racing an editor save that lands first: the save wins (200) and the restore is refused with 409 instead of overwriting it', racerSave.status === 200 && lost.status === 409 && post.content.hero.lede === 'saved while a restore was in flight' && post.version === cur.version + 1 && (await newestHistoryId(store)) === hBeforeRace + 1, `${racerSave.status} ${lost.status}`);
}

/* N. bootstrap */
{
  ok('N. bootstrap: the first start created the default document exactly once, at version 0, by "system", with one history entry', bootRow?.version === 0 && bootRow.updatedBy === 'system' && bootHistory.length === 1 && bootHistory[0].note === 'Initial content');
  const rowBefore = await store.getContent(), idBefore = await newestHistoryId(store);
  const second = await createApp();                               // a second server starting against the same database, which now holds real content
  const rowAfter = await store.getContent();
  ok('N. a second server starting against a database that already has content neither overwrites it, nor changes its version, nor adds a history row', canon(rowAfter) === canon(rowBefore) && rowAfter.version > 0 && (await newestHistoryId(store)) === idBefore);
  await second.store.close?.();
}

/* ═════════════ part 4: source-level scope proofs ═════════════ */
{
  const dbSrc = src('./db.js'), appSrc = src('./app.js'), applySrc = src('./seo/apply.js'), routesSrc = src('./seo/routes.js'), adminSrc = src('./admin/admin.js');
  const start = dbSrc.indexOf('async saveContentIfVersion('), method = dbSrc.slice(start, dbSrc.indexOf('async seedContentIfAbsent(', start));
  ok('db.js: the CAS UPDATE requires the expected version in its WHERE clause, and sets the next version', /UPDATE content SET value = \?, updated_at = \?, updated_by = \?, version = \? WHERE key = 'site' AND COALESCE\(version, 0\) = \?/.test(method) && /\[value, at, userEmail, next, expectedVersion\]/.test(method));
  ok('db.js: the CAS method has no fallback to an unconditional write (no catch, no second UPDATE, no saveContent call)', !/catch/.test(method) && (method.match(/UPDATE content/g) || []).length === 1 && !/saveContent\(/.test(method));
  ok('db.js: the history row is only written after the write is confirmed (the not-written early return comes first)', method.indexOf('if (!written) return') > 0 && method.indexOf('if (!written) return') < method.indexOf('recordContentVersion('));
  ok('db.js: a missing row is created only by an insert-only statement that treats a primary-key violation as "someone else has it" (plus the legacy unconditional save) — not by ON CONFLICT row counts, which pg-mem reports wrongly', /err\?\.code === '23505'/.test(dbSrc) && /UNIQUE constraint failed/.test(dbSrc) && !/ON CONFLICT \(key\)/.test(dbSrc) && (dbSrc.match(/INSERT INTO content \(/g) || []).length === 2);
  ok('db.js: the version column is added with the existing additive addColumn convention, nullable (no NOT NULL / DEFAULT)', /await addColumn\('content', 'version', 'INTEGER'\);/.test(dbSrc));
  ok('db.js: getContent() normalizes a NULL version to 0', /version: r\.version == null \? 0 : Number\(r\.version\)/.test(dbSrc));
  ok('db.js: Hardening #2 is intact — the recommendation transition allow-list is unchanged', /new Set\(\['pending>approved', 'pending>rejected', 'approved>applied', 'approved>failed'\]\)/.test(dbSrc));

  const productionFiles = [];
  for (const dir of ['.', './seo', './admin']) for (const f of readdirSync(fileURLToPath(new URL(dir + '/', import.meta.url)))) if (/\.(js|mjs)$/.test(f) && !f.startsWith('test-')) productionFiles.push(`${dir}/${f}`);
  const users = (needle) => productionFiles.filter((f) => src(f).includes(needle)).sort().join(',');
  ok('no production path bypasses the version check: nothing outside db.js (the definition) calls the unconditional store.saveContent()', users('.saveContent(') === '', users('.saveContent('));
  ok('the production content writers are exactly: the editor save and restore (app.js) and SEO apply (apply.js)', users('saveContentIfVersion(') === './app.js,./db.js,./seo/apply.js', users('saveContentIfVersion('));
  ok('first-start seeding is insert-only and used only by app.js', users('seedContentIfAbsent(') === './app.js,./db.js', users('seedContentIfAbsent('));

  const putSrc = appSrc.slice(appSrc.indexOf("admin.put('/content'"), appSrc.indexOf('// photo upload'));
  ok('app.js: the editor PUT requires an integer version BEFORE it validates or writes anything', putSrc.indexOf('Number.isInteger(version)') > 0 && putSrc.indexOf('Number.isInteger(version)') < putSrc.indexOf('sanitizeContent(') && putSrc.indexOf('sanitizeContent(') < putSrc.indexOf('saveContentIfVersion('));
  ok('app.js: a refused write answers 409 and never reaches remember()/the success response', /if \(!saved\.ok\) return res\.status\(409\)/.test(putSrc) && putSrc.indexOf('if (!saved.ok)') < putSrc.indexOf('remember('));
  ok('app.js: the editor GET returns the version; restore reads the current version itself and goes through the same CAS (409 if refused)', /updatedBy: row\?\.updatedBy, version: row \? row\.version : 0/.test(appSrc) && /Restored version #\$\{req\.params\.id\}`, row \? row\.version : 0\)/.test(appSrc) && /changed while this version was being restored/.test(appSrc));
  ok('app.js: bootstrap uses the insert-only seed, not an unconditional save', /seedContentIfAbsent\(DEFAULT_CONTENT, 'system', 'Initial content'\)/.test(appSrc));

  const applyCode = applySrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  ok('apply.js: one read and ONE compare-and-swap write — no loop and no retry', (applyCode.match(/store\.getContent\(/g) || []).length === 1 && (applyCode.match(/saveContentIfVersion\(/g) || []).length === 1 && !/\b(for|while)\s*\(/.test(applyCode) && (applyCode.match(/applyRecommendation\(/g) || []).length === 1);
  ok('apply.js: a refused write is a distinct conflict result, never a success and never a validation failure', /if \(!saved\.ok\) return \{ ok: false, conflict: true,/.test(applyCode));
  ok('apply.js: the no-op is tied to the recommendation\'s own field (live value === sanitized proposed value), not to a whole-document comparison', /current\.seo\[rec\.type\] === value\.seo\[rec\.type\]/.test(applyCode) && !/JSON\.stringify\(current\) ===|JSON\.stringify\(value\) ===/.test(applyCode));
  ok('routes.js: a content conflict is a 409 that leaves the recommendation approved — it comes before the failed transition and never reaches it', routesSrc.indexOf('if (result.conflict) return res.status(409)') > 0 && routesSrc.indexOf('if (result.conflict) return res.status(409)') < routesSrc.indexOf("to: 'failed'"));
  ok('routes.js: Hardening #2 is intact — still exactly the four guarded transitions', (routesSrc.match(/store\.transitionRecommendation\(/g) || []).length === 4);
  ok('admin.js: the editor keeps the version from GET / save / restore and sends it with every save', /version: meta\.version/.test(adminSrc) && (adminSrc.match(/version: r\.data\.version/g) || []).length === 2 && /version: res\.data\.version/.test(adminSrc) && /r\.status === 409/.test(adminSrc));
  for (const [file, label] of [['./seo/specialistIntegration.js', 'specialist integration'], ['./seo/orchestrator.js', 'orchestrator'], ['./seo/specialistRecommendationConverter.js', 'converter'], ['./seo/jobs.js', 'scan jobs / stale-audit recovery'], ['./seo/crawler.js', 'crawler']]) {
    ok(`scope: ${label} does not touch the content version or the content writers`, !/saveContentIfVersion|seedContentIfAbsent|getContent|content\.version/.test(src(file)));
  }
}

server.closeAllConnections?.(); server.close();
for (const st of [...opened, store]) await st.close?.();
for (const f of dbFiles) for (const s of ['', '-wal', '-shm']) { try { rmSync(f + s, { force: true }); } catch { /* best effort: a leftover temp file is harmless */ } }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
