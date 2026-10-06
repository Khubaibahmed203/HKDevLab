// Phase 4 Hardening #9 — at most ONE queued/running audit per website, enforced by the DATABASE.
// Before: createAuditIfNoneActive() was INSERT … SELECT … WHERE NOT EXISTS with no constraint behind it. Under PostgreSQL's default READ
// COMMITTED two concurrent sessions can both take their snapshot before either commits, both see "nothing active", and both insert — the
// primary key cannot object (the ids differ) — leaving two active audits (two crawls, duplicate recommendations). Now:
//   * a partial unique index on seo_audits (website_id) WHERE status IN ('queued','running') is the authority;
//   * createStore() first fails the older of any already-duplicated active audits of a website (newest kept, history untouched), then builds it;
//   * createAuditIfNoneActive() reports exactly that index's violation as null ("already active"), so POST /scan keeps returning its 409,
//     and rethrows every other error.
// WHAT THIS PROVES: the constraint, the normalization, the loser translation and the route behaviour, on SQLite (including separate OS
// processes on one file) and on pg-mem (the PostgreSQL adapter's SQL). WHAT IT DOES NOT PROVE: real PostgreSQL concurrency. pg-mem is a
// single-threaded emulator with no MVCC; to reach the "loser" path it needs the NOT EXISTS check neutralized (a stand-in for the stale snapshot
// a READ COMMITTED session has), and no PostgreSQL server was available. That the race exists and that the index closes it is argued from
// PostgreSQL's documented semantics, not from a live run.
// Run: node server/test-seo-active-audit-unique.mjs
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { newDb } from 'pg-mem';

const here = fileURLToPath(import.meta.url);
const dbModule = new URL('./db.js', import.meta.url).href;
const INDEX = 'uq_seo_audits_one_active_per_website';
const BASE = 'http://127.0.0.1:9';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ───────────── test hooks ─────────────
   `blind`   rewrites createAuditIfNoneActive()'s statement so its NOT EXISTS can never find an active audit — exactly what a READ COMMITTED
             session whose snapshot predates the winner's commit sees — so ONLY the database constraint can stop the insert.
   `failWith` makes that one statement fail with the given error, to prove which errors are (not) translated.
   The SQLite hook patches the driver's prepare(); the pg-mem hook wraps the pool's query(). Neither touches production code. */
const hook = { blind: false, failWith: null, rewrites: 0, onIndex: null, failIndex: null, indexCalls: 0 };
const isIndexDdl = (sql) => /CREATE UNIQUE INDEX/.test(sql);
/** Runs just before each attempt to build the index: lets a test slip a row in (what another instance's old code could do), or fail the build. */
const beforeIndexDdl = () => { hook.indexCalls++; if (hook.onIndex) hook.onIndex(hook.indexCalls); if (hook.failIndex) throw hook.failIndex; };
const isAuditInsert = (sql) => /INSERT INTO seo_audits/.test(sql) && /WHERE NOT EXISTS/.test(sql);
const blindSql = (sql) => { if (!isAuditInsert(sql)) return sql; hook.rewrites++; return sql.replace("status IN ('queued','running'))", "status IN ('no-such-status'))"); };
const origPrepare = DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare = function (sql) {
  if (hook.failWith && isAuditInsert(sql)) { const e = hook.failWith; return { run() { throw e; }, all() { throw e; } }; }
  return origPrepare.call(this, hook.blind ? blindSql(sql) : sql);
};
const origExecSqlite = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function (sql) { if (isIndexDdl(sql)) beforeIndexDdl(); return origExecSqlite.call(this, sql); };
const wrapPool = (pool) => ({
  query: async (text, params) => { if (isIndexDdl(text)) beforeIndexDdl(); if (hook.failWith && isAuditInsert(text)) throw hook.failWith; return pool.query(hook.blind ? blindSql(text) : text, params); },
  end: () => pool.end(),
});

/* ───────────── child process: one contender in the multi-process SQLite experiment ───────────── */
const MP_GAP = 200, MP_BASE = 5000;
if (process.argv[2] === '--child') {
  const [file, t0, rounds, blind] = process.argv.slice(3);
  process.env.SQLITE_PATH = file; delete process.env.DATABASE_URL;
  // A busy timeout makes every contender WAIT for the file lock instead of failing with "database is locked", so each one really reaches the
  // database's decision (the production adapter sets none; that is a separate matter and not what is under test here).
  const origExec = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function (sql) { return origExec.call(this, /journal_mode/.test(sql) ? `PRAGMA busy_timeout = 10000; ${sql}` : sql); };
  hook.blind = blind === '1';
  const { createStore } = await import(dbModule);
  const store = await createStore();
  const out = [];
  for (let r = 0; r < +rounds; r++) {
    const at = +t0 + r * MP_GAP;
    await sleep(Math.max(0, at - Date.now() - 3));
    while (Date.now() < at) { /* spin to the shared barrier */ }
    try { const a = await store.createAuditIfNoneActive(MP_BASE + r, { baseUrl: BASE, pagesPlanned: 1 }); out.push({ r, id: a ? a.id : null }); }
    catch (e) { out.push({ r, error: String(e.message).slice(0, 120) }); }
  }
  process.stdout.write(`CHILD ${JSON.stringify(out)}\n`);
  await store.close();
  process.exit(0);
}

Object.assign(process.env, { SMTP_HOST: '', SETUP_TOKEN: '', GOOGLE_CLIENT_ID: '', NODE_ENV: 'development' });
for (const k of ['DATABASE_URL', 'PAGESPEED_API_KEY', 'SEO_STALE_AUDIT_MS', 'SEO_MAX_PAGES', 'SEO_MAX_DEPTH', 'SEO_REQUEST_TIMEOUT_MS', 'SEO_CRAWL_DELAY_MS']) delete process.env[k];

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { (cond ? pass++ : fail++); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };
const watchdog = setTimeout(() => { console.log('FAIL  watchdog: the test did not finish in time'); process.exit(1); }, 170_000);
watchdog.unref();

const { createStore, DUPLICATE_ACTIVE_AUDIT_SUMMARY } = await import(dbModule);
const { queueScan } = await import(new URL('./seo/jobs.js', import.meta.url).href);
const src = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const captureErrors = async (fn) => { const lines = [], orig = console.error; console.error = (...a) => lines.push(a.join(' ')); try { await fn(); } finally { console.error = orig; } return lines; };
const numbered = (sql) => { let n = 0; return sql.replace(/\?/g, () => `$${++n}`); };

const files = [];
const tmp = (name) => { const f = join(tmpdir(), `hk-active-audit-unique-${process.pid}-${name}.db`); files.push(f); for (const s of ['', '-wal', '-shm']) rmSync(f + s, { force: true }); return f; };
process.on('exit', () => { for (const f of files) for (const s of ['', '-wal', '-shm']) { try { rmSync(f + s, { force: true }); } catch { /* temp file, harmless */ } } });

/** A fresh database on one backend. `open()` starts ANOTHER store on the same database — a server (re)start; `raw` talks to the tables
 *  directly (with ? placeholders on both), which is how legacy rows and the database's own refusals are produced. */
let seq = 0;
/** `restartable` (pg-mem only): pg-mem refuses to run `CREATE TABLE IF NOT EXISTS` a second time over an existing table while its AST coverage check
 *  is on, so a second store on the same pg-mem database — a server restart — needs the check off. Every other section keeps it ON, so the SQL
 *  this suite exercises (the index, the normalization, the insert) is still verified to be fully understood by pg-mem on first start. */
async function backend(kind, { restartable = false } = {}) {
  const stores = [];
  if (kind === 'sqlite') {
    const file = tmp(`${kind}-${++seq}`);
    const open = async () => { process.env.SQLITE_PATH = file; const s = await createStore(); stores.push(s); return s; };
    const store = await open();
    const rawDb = new DatabaseSync(file); rawDb.exec('PRAGMA busy_timeout = 5000');
    const raw = { all: async (sql, p = []) => rawDb.prepare(sql).all(...p), run: async (sql, p = []) => rawDb.prepare(sql).run(...p).changes };
    return { kind, store, open, raw, rawSync: (sql) => rawDb.exec(sql), close: async () => { rawDb.close(); for (const s of stores) await s.close(); } };
  }
  const mem = newDb(restartable ? { noAstCoverageCheck: true } : undefined);
  const pool = new (mem.adapters.createPg().Pool)();
  const open = async () => { const s = await createStore({ pool: wrapPool(pool) }); stores.push(s); return s; };
  const store = await open();
  const raw = { all: async (sql, p = []) => (await pool.query(numbered(sql), p)).rows, run: async (sql, p = []) => (await pool.query(numbered(sql), p)).rowCount };
  return { kind, store, open, raw, rawSync: (sql) => { mem.public.none(sql); }, close: async () => { await stores[0].close(); } };
}

const countActive = async (b, wid) => Number((await b.raw.all("SELECT COUNT(*) AS n FROM seo_audits WHERE website_id = ? AND status IN ('queued','running')", [wid]))[0].n);
const countAll = async (b, wid) => Number((await b.raw.all('SELECT COUNT(*) AS n FROM seo_audits WHERE website_id = ?', [wid]))[0].n);
/** Inserts one audit row directly, bypassing the store (so no guard but the database's own applies). Terminal rows get a result. */
const seed = async (b, wid, status, ageMin = 0) => {
  const started = new Date(Date.now() - ageMin * 60_000).toISOString(), terminal = status === 'complete' || status === 'failed';
  await b.raw.run('INSERT INTO seo_audits (website_id,started_at,finished_at,score,status,summary,base_url,pages_planned) VALUES (?,?,?,?,?,?,?,?)',
    [wid, started, terminal ? new Date(Date.parse(started) + 1000).toISOString() : null, status === 'complete' ? 80 : null, status, terminal ? `seeded ${status}` : null, 'https://seed.test/', 5]);
  return Number((await b.raw.all('SELECT MAX(id) AS id FROM seo_audits WHERE website_id = ?', [wid]))[0].id);
};
const rowsOf = async (b) => (await b.raw.all('SELECT * FROM seo_audits ORDER BY id')).map((r) => JSON.stringify(r));
const attempt = async (fn) => { try { return { value: await fn() }; } catch (error) { return { error }; } };
const looksUnique = (e) => !!e && (e.code === '23505' || /UNIQUE constraint failed: seo_audits\.website_id/.test(String(e.message)));

for (const kind of ['sqlite', 'pg-mem']) {
  const T = (n) => `[${kind}] ${n}`;

  /* ═════════ A. one active audit per website: sequential ═════════ */
  { const b = await backend(kind), { store } = b;
    const site = await store.ensureWebsite(`unique-a-${kind}.test`, 'A');
    const a1 = await store.createAuditIfNoneActive(site.id, { baseUrl: BASE, pagesPlanned: 5 });
    const a2 = await store.createAuditIfNoneActive(site.id, { baseUrl: BASE, pagesPlanned: 5 });
    ok(T('A1. the first audit of a website is created (queued, with an id)'), !!a1 && a1.status === 'queued' && Number.isInteger(a1.id), JSON.stringify(a1));
    ok(T('A2. a second attempt while one is queued returns null'), a2 === null, JSON.stringify(a2));
    const row = (await store.getAudit(a1.id));
    ok(T('A3. exactly one active audit exists — the first, untouched'), (await countActive(b, site.id)) === 1 && (await countAll(b, site.id)) === 1 && row.status === 'queued' && (await store.activeAudit(site.id)).id === a1.id);
    await store.claimAudit(a1.id);
    ok(T('A4. a RUNNING audit blocks too'), (await store.createAuditIfNoneActive(site.id, { baseUrl: BASE })) === null && (await countActive(b, site.id)) === 1 && (await store.getAudit(a1.id)).status === 'running');
    await store.finishAudit(a1.id, { score: 90, status: 'complete', summary: 'done', pagesCrawled: 1, errorsCount: 0, durationMs: 5 });
    const a3 = await store.createAuditIfNoneActive(site.id, { baseUrl: BASE });
    ok(T('A5. once the audit is complete, a new one is allowed (the index only covers queued/running)'), !!a3 && a3.id > a1.id && (await countActive(b, site.id)) === 1 && (await countAll(b, site.id)) === 2);
    await store.finishAudit(a3.id, { score: null, status: 'failed', summary: 'x' });
    const a4 = await store.createAuditIfNoneActive(site.id, { baseUrl: BASE });
    ok(T('A6. …and after a FAILED one as well'), !!a4 && a4.id > a3.id && (await countActive(b, site.id)) === 1);
    await b.close();
  }

  /* ═════════ B. different websites do not conflict ═════════ */
  { const b = await backend(kind), { store } = b;
    const sites = []; for (let i = 0; i < 3; i++) sites.push(await store.ensureWebsite(`unique-b${i}-${kind}.test`, `B${i}`));
    const first = []; for (const s of sites) first.push(await store.createAuditIfNoneActive(s.id, { baseUrl: BASE }));
    const second = []; for (const s of sites) second.push(await store.createAuditIfNoneActive(s.id, { baseUrl: BASE }));
    ok(T('B1. three websites each get one active audit'), first.every((a) => a && a.status === 'queued') && new Set(first.map((a) => a.id)).size === 3);
    ok(T('B2. …and a second attempt on each is refused individually'), second.every((a) => a === null));
    ok(T('B3. each website has exactly one active audit'), (await Promise.all(sites.map((s) => countActive(b, s.id)))).every((n) => n === 1));
    const rawOther = await attempt(() => seed(b, 777, 'queued'));
    ok(T('B4. a direct insert of an active audit for yet another website is accepted'), !rawOther.error, String(rawOther.error));
    await b.close();
  }

  /* ═════════ C. history is unlimited; the index sees only active rows ═════════ */
  { const b = await backend(kind), { store } = b;
    const site = await store.ensureWebsite(`unique-c-${kind}.test`, 'C');
    for (let i = 0; i < 6; i++) { const a = await store.createAuditIfNoneActive(site.id, { baseUrl: BASE }); await store.finishAudit(a.id, { score: 70 + i, status: 'complete', summary: 'ok', pagesCrawled: 1, errorsCount: 0, durationMs: 1 }); }
    for (let i = 0; i < 6; i++) { const a = await store.createAuditIfNoneActive(site.id, { baseUrl: BASE }); await store.finishAudit(a.id, { score: null, status: 'failed', summary: 'x' }); }
    const live = await store.createAuditIfNoneActive(site.id, { baseUrl: BASE });
    ok(T('C1. six complete and six failed audits through the store, then one active audit: all accepted'), !!live && (await countAll(b, site.id)) === 13 && (await countActive(b, site.id)) === 1);
    let rawErr = null; try { for (let i = 0; i < 5; i++) { await seed(b, site.id, 'complete'); await seed(b, site.id, 'failed'); } } catch (e) { rawErr = e; }
    ok(T('C2. five more complete and five more failed rows inserted directly next to the active one: all accepted'), rawErr === null && (await countAll(b, site.id)) === 23 && (await countActive(b, site.id)) === 1, String(rawErr));
    const dup = await attempt(() => seed(b, site.id, 'running'));
    ok(T('C3. a direct insert of a second active audit is refused BY THE DATABASE with a unique violation'), looksUnique(dup.error), String(dup.error?.message).slice(0, 160));
    ok(T('C3. …and nothing was inserted'), (await countAll(b, site.id)) === 23 && (await countActive(b, site.id)) === 1);
    const helper = await attempt(() => store.createAudit(site.id, { baseUrl: BASE, status: 'running' }));
    ok(T('C4. the test-only createAudit() helper cannot create a second active audit either (it throws; it never silently duplicates)'), looksUnique(helper.error) && (await countActive(b, site.id)) === 1);
    await b.close();
  }

  /* ═════════ C′. every ordered pair of active statuses conflicts ═════════ */
  { const b = await backend(kind); const verdicts = [];
    let wid = 8000;
    for (const first of ['queued', 'running']) for (const second of ['queued', 'running']) {
      wid++; await seed(b, wid, first); const r = await attempt(() => seed(b, wid, second));
      verdicts.push(`${first}→${second}:${looksUnique(r.error) ? 'refused' : 'ACCEPTED'}`);
    }
    ok(T('C5. queued→queued, queued→running, running→queued and running→running are all refused'), verdicts.every((v) => v.endsWith('refused')), verdicts.join(' '));
    await b.close();
  }

  /* ═════════ D/E. normalizing databases that already hold duplicate active audits ═════════ */
  { const b = await backend(kind, { restartable: true });
    await b.raw.run(`DROP INDEX ${INDEX}`);                                  // the legacy state: a database from before the index existed
    const layout = {                                                          // website → statuses, inserted in this order (ids grow)
      101: ['complete', 'running', 'queued', 'failed', 'complete'],           // older RUNNING, newer QUEUED → the newest (queued) survives
      102: ['failed', 'queued', 'running'],                                   // older queued, newer running → running survives
      103: ['running', 'running', 'queued', 'failed'],                        // three active → only the newest survives
      104: ['complete', 'running'],                                           // a single active audit → untouched
      105: ['complete', 'failed', 'complete'],                                // history only → untouched
    };
    const seeded = []; let setupErr = null;
    try { for (const [wid, statuses] of Object.entries(layout)) for (const s of statuses) seeded.push({ wid: +wid, status: s, id: await seed(b, +wid, s, 5) }); } catch (e) { setupErr = e; }
    ok(T('D0. setup: with the index dropped the database accepts duplicate active audits (the legacy state to repair)'), setupErr === null && seeded.length === 17, String(setupErr));
    const active = (r) => r.status === 'queued' || r.status === 'running';
    const survivorOf = (wid) => seeded.filter((r) => r.wid === wid && active(r)).reduce((m, r) => (r.id > m ? r.id : m), 0);
    const expectedLosers = seeded.filter((r) => active(r) && r.id !== survivorOf(r.wid));
    const before = await rowsOf(b), tBefore = Date.now();

    let started = null; const logs = await captureErrors(async () => { started = await attempt(() => b.open()); });
    ok(T('D1. starting the server over those duplicates succeeds (normalized first, then the index is built)'), !started.error, String(started.error?.message).slice(0, 200));
    if (!started.error) {
      const after = await rowsOf(b), rowsNow = after.map((r) => JSON.parse(r)), byId = new Map(rowsNow.map((r) => [r.id, r]));
      ok(T('D2. exactly one active audit remains on every website that had one or more (101-104), and none on the history-only website'), [101, 102, 103, 104].every((w) => rowsNow.filter((r) => r.website_id === w && active(r)).length === 1) && rowsNow.filter((r) => r.website_id === 105 && active(r)).length === 0);
      ok(T('D3. the survivor is the NEWEST active audit (highest id) — even when an older one was already running and the newer one is only queued'), [101, 102, 103, 104].every((w) => rowsNow.find((r) => r.website_id === w && active(r))?.id === survivorOf(w)), JSON.stringify(rowsNow.filter(active).map((r) => [r.website_id, r.id, r.status])));
      ok(T('D3. …so 101 keeps its queued audit over its older running one, and 102 keeps its running one over its older queued one'), byId.get(survivorOf(101)).status === 'queued' && byId.get(survivorOf(102)).status === 'running');
      ok(T(`D4. every superseded audit (${expectedLosers.length}) is failed, with finished_at set (a valid time from this run), the normalization summary, and no score`), expectedLosers.length === 4 && expectedLosers.every((l) => { const r = byId.get(l.id); return r.status === 'failed' && /^\d{4}-\d\d-\d\dT/.test(r.finished_at || '') && Date.parse(r.finished_at) >= tBefore - 1000 && r.summary === DUPLICATE_ACTIVE_AUDIT_SUMMARY && r.score == null; }));
      ok(T('D5. nothing was deleted: the same ids are present'), after.length === before.length && JSON.stringify(rowsNow.map((r) => r.id)) === JSON.stringify(seeded.map((r) => r.id)));
      const untouched = (pred) => seeded.filter(pred).every((s) => after.includes(before.find((x) => JSON.parse(x).id === s.id)));
      ok(T('D6. historical complete and failed audits are byte-for-byte unchanged'), untouched((r) => !active(r)));
      ok(T('D7. the survivors are unchanged too (still active, finished_at still empty), and so are the websites with a single active audit or none'), untouched((r) => r.id === survivorOf(r.wid)) && untouched((r) => r.wid === 104 || r.wid === 105));
      ok(T('D8. the repair is reported once, with its count'), logs.filter((l) => /duplicate active audit/.test(l)).length === 1 && /failed 4 duplicate active audit/.test(logs.join('\n')), logs.join(' | '));
      const dup = await attempt(() => seed(b, 101, 'queued'));
      ok(T('D9. the index now exists: a further direct duplicate is refused'), looksUnique(dup.error));
      ok(T('D9. …and createAuditIfNoneActive() on a website that kept its audit returns null'), (await b.store.createAuditIfNoneActive(104, { baseUrl: BASE })) === null);

      // E. idempotent
      const snap = await rowsOf(b); let again = [];
      const logs2 = await captureErrors(async () => { again.push(await attempt(() => b.open())); again.push(await attempt(() => b.open())); });
      ok(T('E1. normalizing again (two more starts) changes nothing at all — every column of every row is identical'), again.every((x) => !x.error) && JSON.stringify(await rowsOf(b)) === JSON.stringify(snap), again.map((x) => x.error?.message).join('|'));
      ok(T('E2. …and reports nothing, because there was nothing to repair'), logs2.length === 0, logs2.join(' | '));
    }
    await b.close();
  }
  { const b = await backend(kind, { restartable: true }); const before = await rowsOf(b); const logs = await captureErrors(async () => { await b.open(); });
    ok(T('E3. starting on a clean database repairs and reports nothing'), before.length === 0 && logs.length === 0 && (await rowsOf(b)).length === 0);
    await b.close();
  }

  /* ═════════ K. the startup retry ═════════ */
  { const b = await backend(kind, { restartable: true });
    await b.raw.run(`DROP INDEX ${INDEX}`);
    const iso = () => new Date().toISOString();
    const insertActive = (wid, status) => b.rawSync(`INSERT INTO seo_audits (website_id,started_at,status) VALUES (${wid}, '${iso()}', '${status}')`);
    insertActive(301, 'running');
    hook.indexCalls = 0; hook.onIndex = (n) => { if (n === 1) insertActive(301, 'queued'); };    // another instance (old code) adds a duplicate AFTER the repair, BEFORE the index build
    let started; const logs = await captureErrors(async () => { try { started = await attempt(() => b.open()); } finally { hook.onIndex = null; } });
    const rows = (await b.raw.all('SELECT id, status FROM seo_audits WHERE website_id = 301 ORDER BY id')).map((r) => `${r.status}`);
    ok(T('K1. a duplicate that slips in between the repair and the index build makes the first build fail; the retry repairs it and startup succeeds'), !started.error && hook.indexCalls === 2 && rows.join() === 'failed,queued', JSON.stringify([started.error?.message, hook.indexCalls, rows]));
    // pg-mem leaves a FAILED index build half-registered under its name, so the retry's IF NOT EXISTS then builds nothing there (a pg-mem artifact:
    // real PostgreSQL and SQLite roll a failed CREATE UNIQUE INDEX back entirely) — the index can therefore only be checked after a retry on SQLite.
    const inPlace = kind === 'pg-mem' || looksUnique((await attempt(() => b.raw.run(`INSERT INTO seo_audits (website_id,started_at,status) VALUES (301, '${iso()}', 'running')`))).error);
    ok(T(`K1. …the retry is logged once${kind === 'sqlite' ? ', and the index is in place afterwards' : ' (pg-mem cannot show the index after a failed build — see the comment)'}`), logs.filter((l) => /could not build the one-active-audit index \(attempt 1 of 3\)/.test(l)).length === 1 && inPlace, logs.join(' | ').slice(0, 300));
    await b.close();
  }
  { const b = await backend(kind, { restartable: true });
    await b.raw.run(`DROP INDEX ${INDEX}`);
    const boom = Object.assign(new Error('permission denied for table seo_audits'), { code: '42501' });
    hook.indexCalls = 0; hook.failIndex = boom; let refused; const logs2 = await captureErrors(async () => { try { refused = await attempt(() => b.open()); } finally { hook.failIndex = null; } });
    ok(T('K2. an index that can never be built stops the server with that very error after three attempts — it never carries on unprotected'), refused.error === boom && hook.indexCalls === 3 && logs2.filter((l) => /could not build the one-active-audit index/.test(l)).length === 2, JSON.stringify([String(refused.error), hook.indexCalls, logs2.length]));
    await b.close();
  }

  /* ═════════ F. the uniqueness loser ═════════ */
  { const b = await backend(kind), { store } = b;
    const site = await store.ensureWebsite(`unique-f-${kind}.test`, 'F');
    const winner = await store.createAuditIfNoneActive(site.id, { baseUrl: BASE, pagesPlanned: 5 });
    hook.rewrites = 0;
    const direct = await attempt(() => b.raw.run(blindSql("INSERT INTO seo_audits (website_id,started_at,status) SELECT CAST(? AS BIGINT), ?, 'queued' WHERE NOT EXISTS (SELECT 1 FROM seo_audits WHERE website_id = CAST(? AS BIGINT) AND status IN ('queued','running'))"), [site.id, new Date().toISOString(), site.id]));
    ok(T('F1. the stale-snapshot statement (NOT EXISTS blind to the winner) inserts into the table and is REFUSED BY THE DATABASE with a unique violation'), hook.rewrites === 1 && looksUnique(direct.error), String(direct.error?.message).slice(0, 160));
    hook.blind = true; hook.rewrites = 0; let loser; try { loser = await attempt(() => store.createAuditIfNoneActive(site.id, { baseUrl: BASE, pagesPlanned: 5 })); } finally { hook.blind = false; }
    ok(T('F2. through createAuditIfNoneActive() the loser of that conflict gets null — the contract is unchanged'), hook.rewrites === 1 && !loser.error && loser.value === null, JSON.stringify(loser));
    ok(T('F3. only the winner exists: one row, still queued, same id'), (await countAll(b, site.id)) === 1 && (await countActive(b, site.id)) === 1 && (await store.activeAudit(site.id)).id === winner.id);
    hook.blind = true; let viaQueue; const qlogs = await captureErrors(async () => { try { viaQueue = await attempt(() => queueScan(store, site, { baseUrl: BASE })); } finally { hook.blind = false; } });
    ok(T('F4. queueScan() passes that null on (the route turns it into the 409), schedules no crawl, and still logs nothing'), !viaQueue.error && viaQueue.value === null && qlogs.length === 0 && (await countAll(b, site.id)) === 1, JSON.stringify([viaQueue, qlogs]));
    await b.close();
  }

  /* ═════════ H. only that conflict becomes null ═════════ */
  { const b = await backend(kind), { store } = b;
    const site = await store.ensureWebsite(`unique-h-${kind}.test`, 'H');
    const mk = (message, props = {}) => Object.assign(new Error(message), props);
    const unrelated = [
      ['a lock/busy failure', mk('database is locked', { code: 'ERR_SQLITE_ERROR' })],
      ['a serialization failure (40001)', mk('could not serialize access', { code: '40001' })],
      ['a connection failure', mk('connect ECONNREFUSED', { code: 'ECONNREFUSED' })],
      ['a foreign-key violation (23503)', mk('violates foreign key constraint', { code: '23503' })],
      ['a unique violation of ANOTHER constraint (the primary key, 23505)', mk('duplicate key value violates unique constraint "seo_audits_pkey"', { code: '23505', constraint: 'seo_audits_pkey' })],
      ['SQLite\'s unique violation on the id column', mk('UNIQUE constraint failed: seo_audits.id', { code: 'ERR_SQLITE_ERROR' })],
      ['a programming error', new TypeError('x is not a function')],
    ];
    for (const [what, err] of unrelated) {
      hook.failWith = err; let r; try { r = await attempt(() => store.createAuditIfNoneActive(site.id, { baseUrl: BASE })); } finally { hook.failWith = null; }
      ok(T(`H1. ${what} is NOT turned into null: the very same error is thrown`), r.error === err && r.value === undefined, JSON.stringify([String(r.error), r.value]));
    }
    ok(T('H1. …and none of those failures created an audit'), (await countAll(b, site.id)) === 0);
    const conflicts = [
      ['PostgreSQL: 23505 on the one-active-audit index', mk('duplicate key value violates unique constraint', { code: '23505', constraint: INDEX })],
      ['pg-mem: 23505 (it reports no constraint name)', mk('duplicate key value violates unique constraint', { code: '23505' })],
      ['SQLite: unique violation on seo_audits.website_id', mk('UNIQUE constraint failed: seo_audits.website_id', { code: 'ERR_SQLITE_ERROR' })],
    ];
    for (const [what, err] of conflicts) {
      hook.failWith = err; let r; try { r = await attempt(() => store.createAuditIfNoneActive(site.id, { baseUrl: BASE })); } finally { hook.failWith = null; }
      ok(T(`H2. ${what} IS the conflict: null, no throw`), !r.error && r.value === null, JSON.stringify([String(r.error), r.value]));
    }
    const ordinary = await store.createAuditIfNoneActive(site.id, { baseUrl: BASE });
    ok(T('H3. with no failure injected the same call still creates the audit (the hook is not what makes it work)'), !!ordinary && ordinary.status === 'queued' && (await countAll(b, site.id)) === 1);
    await b.close();
  }

  /* ═════════ I. contention ═════════ */
  { const b = await backend(kind), second = kind === 'sqlite' ? await b.open() : null, stores = second ? [b.store, second] : [b.store];
    const ROUNDS = 40, CALLERS = 8;
    for (const blind of [false, true]) {
      let wid = blind ? 20_000 : 10_000, bad = [], winnersTotal = 0, losersNull = 0;
      for (let round = 0; round < ROUNDS; round++) {
        wid++; hook.blind = blind;
        let settled; try { settled = await Promise.allSettled(Array.from({ length: CALLERS }, (_, i) => stores[i % stores.length].createAuditIfNoneActive(wid, { baseUrl: BASE, pagesPlanned: 3 }))); } finally { hook.blind = false; }
        const won = settled.filter((s) => s.status === 'fulfilled' && s.value), nulls = settled.filter((s) => s.status === 'fulfilled' && s.value === null), thrown = settled.filter((s) => s.status === 'rejected');
        if (won.length !== 1 || nulls.length !== CALLERS - 1 || thrown.length || (await countActive(b, wid)) !== 1) bad.push(`round ${round}: won ${won.length}, null ${nulls.length}, threw ${thrown.length} ${thrown[0]?.reason?.message || ''}`);
        winnersTotal += won.length; losersNull += nulls.length;
      }
      const what = blind ? 'with the NOT EXISTS check neutralized (only the database constraint can stop the extra inserts)' : 'with the real statement';
      ok(T(`I${blind ? 2 : 1}. ${ROUNDS} rounds of ${CALLERS} simultaneous callers per website${second ? ' over two connections to one file' : ''}, ${what}: exactly one wins every round, the rest get null, nobody throws, one active row remains`), bad.length === 0 && winnersTotal === ROUNDS && losersNull === ROUNDS * (CALLERS - 1), bad.slice(0, 3).join('; '));
    }
    if (kind === 'pg-mem') console.log('      (pg-mem: the constraint and the loser translation are exercised, but pg-mem is a single-threaded emulator with no MVCC — this is NOT evidence about PostgreSQL concurrency)');
    await b.close();
  }
}

/* ═════════ I3. separate OS processes on one SQLite file ═════════ */
{
  const PROCS = 4, ROUNDS = 10;
  const file = tmp('multiprocess');
  process.env.SQLITE_PATH = file; const seedStore = await createStore(); await seedStore.close();   // the schema, once
  const runPhase = async (blind) => {
    const t0 = Date.now() + 3500;
    const kids = Array.from({ length: PROCS }, () => new Promise((resolve) => {
      let out = ''; const p = spawn(process.execPath, [here, '--child', file, String(t0), String(ROUNDS), blind ? '1' : '0'], { stdio: ['ignore', 'pipe', 'ignore'] });
      p.stdout.on('data', (d) => { out += d; }); p.on('close', () => resolve(out)); p.on('error', () => resolve(out));
    }));
    const results = (await Promise.all(kids)).map((o) => { const line = o.split('\n').find((l) => l.startsWith('CHILD ')); return line ? JSON.parse(line.slice(6)) : null; });
    return results;
  };
  const rawDb = new DatabaseSync(file); rawDb.exec('PRAGMA busy_timeout = 5000');
  for (const blind of [false, true]) {
    const results = await runPhase(blind), reported = results.filter(Boolean);
    let bad = [], errors = 0, rounds = 0, winners = 0;
    if (reported.length === PROCS) for (let r = 0; r < ROUNDS; r++) {
      rounds++; const mine = reported.map((res) => res.find((x) => x.r === r)), won = mine.filter((x) => x.id), errs = mine.filter((x) => x.error);
      errors += errs.length; winners += won.length;
      const active = Number(rawDb.prepare("SELECT COUNT(*) AS n FROM seo_audits WHERE website_id = ? AND status IN ('queued','running')").get(MP_BASE + r).n);
      if (won.length > 1 || active > 1) bad.push(`round ${r}: ${won.length} winners, ${active} active rows`);
    }
    ok(`[sqlite, ${PROCS} OS processes] I3. ${blind ? 'NOT EXISTS neutralized (the constraint alone)' : 'real statement'}: all ${PROCS} processes reported`, reported.length === PROCS, `${reported.length} of ${PROCS} reported`);
    ok(`[sqlite, ${PROCS} OS processes] I3. …${ROUNDS} barrier-synchronized rounds: never more than one winner and never more than one active row per website`, rounds === ROUNDS && bad.length === 0, bad.join('; '));
    ok(`[sqlite, ${PROCS} OS processes] I3. …every round produced exactly one winner and no process failed (the others got null)`, winners === ROUNDS && errors === 0, JSON.stringify({ winners, errors }));
    // both phases use the same website ids (MP_BASE + round), so end the first phase's active audits before the second begins
    if (!blind) rawDb.prepare("UPDATE seo_audits SET status = 'failed', finished_at = ? WHERE status IN ('queued','running')").run(new Date().toISOString());
  }
  rawDb.close();
}

/* ═════════ G. POST /scan through the real app ═════════ */
{
  const route = tmp('route'); process.env.SQLITE_PATH = route;
  const { createApp } = await import(new URL('./app.js', import.meta.url).href);
  const { app, store } = await createApp();
  const server = await new Promise((r) => { const s = app.listen(8841, () => r(s)); });
  const base = 'http://localhost:8841'; process.env.PUBLIC_URL = base;
  let cookie = '';
  const call = async (method, path, json) => {
    const h = { 'X-Requested-With': 'hk-admin' }; if (json !== undefined) h['Content-Type'] = 'application/json'; if (cookie) h.Cookie = cookie;
    const res = await fetch(base + path, { method, headers: h, body: json !== undefined ? JSON.stringify(json) : undefined });
    for (const c of res.headers.getSetCookie?.() || []) { const [kv] = c.split(';'); const [k, v] = kv.split('='); cookie = v === '' ? '' : `${k}=${v}`; }
    let data = {}; try { data = await res.json(); } catch { /* not JSON */ }
    return { status: res.status, data };
  };
  let r = await call('POST', '/api/auth/setup', { name: 'Unique Admin', email: 'unique-test@example.com', password: 'a-long-test-password-1' });
  ok('[route] G0. setup: test admin created', r.status === 201, JSON.stringify(r.data));
  const home = await store.ensureWebsite('localhost:8841', 'HK DevLab');
  const active = await store.createAuditIfNoneActive(home.id, { baseUrl: base, pagesPlanned: 5 });   // queued and never executed

  r = await call('POST', '/api/admin/seo/scan');
  const plain = r;
  ok('[route] G1. a POST /scan while an audit is active is still HTTP 409, with the existing error text and that audit', r.status === 409 && r.data.ok === false && /already queued or running/.test(r.data.error) && r.data.audit?.id === active.id, JSON.stringify(r.data));
  ok('[route] G1. …and no second audit was created', (await store.listAudits(home.id)).length === 1);

  hook.blind = true; hook.rewrites = 0; try { r = await call('POST', '/api/admin/seo/scan'); } finally { hook.blind = false; }
  ok('[route] G2. the UNIQUENESS LOSER (the NOT EXISTS check blind to the winner, the database constraint decides) also produces HTTP 409 with the same body', hook.rewrites >= 1 && r.status === 409 && JSON.stringify(r.data) === JSON.stringify(plain.data), JSON.stringify([hook.rewrites, r.status, r.data]));
  ok('[route] G2. …and still only the winner exists', (await store.listAudits(home.id)).length === 1 && (await store.activeAudit(home.id)).id === active.id);

  for (const err of [Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR' }), Object.assign(new Error('UNIQUE constraint failed: seo_audits.id'), { code: 'ERR_SQLITE_ERROR' })]) {
    hook.failWith = err; let lines; try { lines = await captureErrors(async () => { r = await call('POST', '/api/admin/seo/scan'); }); } finally { hook.failWith = null; }
    ok(`[route] G3. an unrelated database failure ("${err.message}") is an error (500), NOT a 409, and it is logged`, r.status === 500 && r.data.ok === false && r.status !== 409 && lines.some((l) => l.includes(err.message)), JSON.stringify([r.status, r.data]));
  }
  ok('[route] G3. …and those failures created no audit', (await store.listAudits(home.id)).length === 1);

  await store.finishAudit(active.id, { status: 'failed', summary: 'test cleanup — never crawled' });
  r = await call('POST', '/api/admin/seo/scan');
  ok('[route] G4. once the audit is over, a new POST /scan is accepted (202, queued) — the index does not block a legitimate scan', r.status === 202 && r.data.audit?.status === 'queued' && r.data.audit.id > active.id, JSON.stringify(r.data));
  for (let i = 0; i < 400; i++) { const a = await store.getAudit(r.data.audit.id); if (a.status !== 'queued' && a.status !== 'running') break; await sleep(25); }
  ok('[route] G4. …and that scan runs to the end through the normal lifecycle (claim, crawl, finish) without a conflict', ['complete', 'failed'].includes((await store.getAudit(r.data.audit.id)).status) && (await store.activeAudit(home.id)) === undefined);
  server.close(); await store.close();
}

/* ═════════ J. scope proofs ═════════ */
{
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
  const dbSrc = strip(src('./db.js')), jobs = strip(src('./seo/jobs.js')), routes = strip(src('./seo/routes.js'));
  const startup = dbSrc.slice(dbSrc.indexOf('const normalizeActiveAudits'), dbSrc.indexOf('const enq = '));
  const loop = startup.slice(startup.indexOf('for (let attempt = 1;')), create =dbSrc.slice(dbSrc.indexOf('async createAuditIfNoneActive'), dbSrc.indexOf('async finishAudit'));
  ok('J1. db.js defines exactly one unique index: partial, on seo_audits (website_id), for queued/running rows only — not a plain unique index on website_id', (dbSrc.match(/CREATE UNIQUE INDEX/g) || []).length === 1 && /CREATE UNIQUE INDEX IF NOT EXISTS \$\{ACTIVE_AUDIT_INDEX\} ON seo_audits \(website_id\) WHERE status IN \('queued','running'\)/.test(dbSrc) && /ACTIVE_AUDIT_INDEX = 'uq_seo_audits_one_active_per_website'/.test(dbSrc));
  ok('J2. the normalization runs BEFORE every attempt to build the index, and a failure to build it after the retries is thrown, never swallowed', loop.indexOf('await normalizeActiveAudits()') > 0 && loop.indexOf('await normalizeActiveAudits()') < loop.indexOf('CREATE UNIQUE INDEX') && /if \(attempt >= 3\) throw err;/.test(loop));
  ok('J3. the normalization is one UPDATE that only touches queued/running rows other than each website\'s newest, and never deletes anything', /UPDATE seo_audits SET status = 'failed', finished_at = \?, summary = \?\s*WHERE status IN \('queued','running'\)\s*AND id NOT IN \(SELECT MAX\(id\) FROM seo_audits WHERE status IN \('queued','running'\) GROUP BY website_id\)/.test(dbSrc) && !/DELETE FROM seo_audits/.test(dbSrc));
  ok('J4. createAuditIfNoneActive(): the only catch translates the one-active-audit conflict to null and rethrows everything else', /catch \(err\) \{\s*if \(isActiveAuditConflict\(err\)\) return null;\s*throw err;\s*\}/.test(create) && (create.match(/catch/g) || []).length === 1 && /WHERE NOT EXISTS \(SELECT 1 FROM seo_audits WHERE website_id = CAST\(\? AS BIGINT\) AND status IN \('queued','running'\)\)/.test(create));
  ok('J5. the conflict test is narrow: SQLSTATE 23505 on this index (or unnamed), or SQLite\'s seo_audits.website_id — nothing broader', /const isActiveAuditConflict = \(err\) => err\?\.code === '23505'\s*\? !err\.constraint \|\| err\.constraint === ACTIVE_AUDIT_INDEX\s*: \/UNIQUE constraint failed: seo_audits\\\.website_id\\b\/\.test\(String\(err\?\.message\)\);/.test(dbSrc));
  ok('J6. no transaction, lock, isolation change, advisory lock or in-memory mutex was introduced, and neither the audit creation nor the startup repair uses ON CONFLICT (pg-mem miscounts its rows; the media upsert elsewhere is not part of this)', !/BEGIN|COMMIT|ROLLBACK|FOR UPDATE|pg_advisory|LOCK TABLE|ISOLATION|Mutex|mutex|semaphore/i.test(dbSrc) && !/ON CONFLICT/i.test(create + startup) && startup.length > 200 && (dbSrc.match(/ADD COLUMN/g) || []).length === 2);
  ok('J7. the route and queueScan are untouched in shape: a null from queueScan is the 409, and finishAudit is still called exactly twice', /const audit = await queueScan\(store, website, \{ baseUrl \}\);\s*if \(!audit\) \{\s*const active = await store\.activeAudit\(website\.id\);\s*return res\.status\(409\)/.test(routes) && /const audit = await store\.createAuditIfNoneActive\(website\.id, \{ baseUrl, pagesPlanned: limits\.maxPages \}\);\s*if \(!audit\) return null;/.test(jobs) && (jobs.match(/store\.finishAudit\(/g) || []).length === 2);
  ok('J8. Hardening #2, #3 and #8 are intact in db.js: the recommendation transition list, the content CAS, and the page ownership guard', /new Set\(\['pending>approved', 'pending>rejected', 'approved>applied', 'approved>failed'\]\)/.test(dbSrc) && /UPDATE content SET value = \?, updated_at = \?, updated_by = \?, version = \? WHERE key = 'site' AND COALESCE\(version, 0\) = \?/.test(dbSrc) && /WHERE id=\? AND \(last_audit_id IS NULL OR NOT \(last_audit_id > \? AND last_audit_id IN \(SELECT id FROM seo_audits WHERE website_id = \?\)\)\)/.test(dbSrc));
}

console.log(`\n${pass} passed, ${fail} failed`);
setTimeout(() => process.exit(fail ? 1 : 0), 300);
