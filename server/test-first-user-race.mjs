// Phase 5 D5.1e.2 — the FIRST ACCOUNT is claimed by the DATABASE, not by a bare INSERT … WHERE NOT EXISTS.
// Before: createFirstUser() was one INSERT … SELECT … WHERE NOT EXISTS. On PostgreSQL's default READ COMMITTED two simultaneous attempts (different e-mails) both see "no users" and both insert, and no other
// constraint stops them — reproduced on a real PostgreSQL 17.11 (Phase 5 D5.1e.1): two administrators, no error. Now the first account is written with bootstrap = 1 and a partial unique index
// (uq_users_one_bootstrap) admits at most ONE such row; the loser's INSERT is rejected and exactly that violation is reported as null (setup answers "already completed"; Google answers not_invited).
// WHAT THIS PROVES: the column, the index, the migration of existing databases, the loser translation, that other errors stay errors, and the two callers — on SQLite (the real driver) and on pg-mem (the
// PostgreSQL adapter's SQL). To reach the "loser" path the NOT EXISTS check is neutralised ("blind"): exactly what a READ COMMITTED session whose snapshot predates the winner's commit sees — so ONLY the
// database constraint can stop the second insert. WHAT IT DOES NOT PROVE: real PostgreSQL concurrency (pg-mem is single-threaded, with no MVCC). That was confirmed against a disposable local PostgreSQL
// 17.11 in Phase 5 D5.1e.2 — it needs a server, so it is deliberately NOT part of this file or of npm test.
// Run: node server/test-first-user-race.mjs      (uses throw-away SQLite files and ports 8861-8864)
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { newDb } from 'pg-mem';

Object.assign(process.env, { SMTP_HOST: '', SETUP_TOKEN: '', GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', NODE_ENV: 'development', CONTENT_TTL_MS: '150' });
for (const k of ['DATABASE_URL', 'PAGESPEED_API_KEY', 'SQLITE_PATH', 'PUBLIC_URL']) delete process.env[k];

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { (cond ? pass++ : fail++); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };
const watchdog = setTimeout(() => { console.log('FAIL  watchdog: the test did not finish in time'); process.exit(1); }, 150_000);
watchdog.unref();
const src = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const files = [];
const dbFile = (tag) => { const f = join(tmpdir(), `hk-first-user-${tag}-${process.pid}.db`); for (const s of ['', '-wal', '-shm']) rmSync(f + s, { force: true }); files.push(f); return f; };
const cleanup = () => { for (const f of files) for (const s of ['', '-wal', '-shm']) rmSync(f + s, { force: true }); };

const A = { email: 'first-a@example.com', name: 'First A', passwordHash: 'scrypt:test-hash-a', role: 'admin' };
const B = { email: 'first-b@example.com', name: 'First B', passwordHash: 'scrypt:test-hash-b', role: 'admin' };

/* ───────────── test hooks ─────────────
   `blind`   rewrites createFirstUser()'s statement so its NOT EXISTS can never find a user — what a READ COMMITTED session whose snapshot predates the winner's commit sees — so ONLY the constraint can stop it.
   `failWith` makes that one statement fail with the given error, to prove which errors are (not) translated.
   The SQLite hook patches the driver's prepare(); the pg-mem hook wraps the pool's query(). Neither touches production code. */
const hook = { blind: false, failWith: null, rewrites: 0, nameIt: true };
const isFirstUserInsert = (sql) => /INSERT INTO users/.test(sql) && /WHERE NOT EXISTS/.test(sql);
const blindSql = (sql) => { if (!isFirstUserInsert(sql)) return sql; hook.rewrites++; return sql.replace('WHERE NOT EXISTS (SELECT 1 FROM users)', 'WHERE 1 = 1'); };
const origPrepare = DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare = function (sql) {
  if (hook.failWith && isFirstUserInsert(sql)) { const e = hook.failWith; return { run() { throw e; }, all() { throw e; } }; }
  return origPrepare.call(this, hook.blind ? blindSql(sql) : sql);
};
/** pg-mem reports 23505 WITHOUT the constraint name that real PostgreSQL puts in err.constraint. Optionally add that name (derived from pg-mem's own message), so the production predicate sees the real shape. */
const realPgShape = (e) => {
  if (hook.nameIt && e?.code === '23505' && !e.constraint) { const m = /returning "(\w+)"/.exec(String(e.message)); if (m) e.constraint = m[1] === 'bootstrap' ? 'uq_users_one_bootstrap' : m[1] === 'email' ? 'users_email_key' : 'users_pkey'; }
  return e;
};
const wrapPool = (pool) => ({
  query: async (text, params) => {
    if (hook.failWith && isFirstUserInsert(text)) throw hook.failWith;
    try { return await pool.query(hook.blind ? blindSql(text) : text, params); } catch (e) { throw realPgShape(e); }
  },
  end: () => pool.end(),
});
const mk = (message, props = {}) => Object.assign(new Error(message), props);
const attempt = async (fn) => { try { return { value: await fn() }; } catch (error) { return { error }; } };

const { createStore } = await import(new URL('./db.js', import.meta.url).href);
const openSqlite = async (file) => { process.env.SQLITE_PATH = file; return createStore(); };
const openMem = async (restartable = false) => {
  const mem = newDb(restartable ? { noAstCoverageCheck: true } : undefined); const { Pool } = mem.adapters.createPg(); const inner = new Pool();
  const store = await createStore({ pool: wrapPool(inner) });
  return { mem, inner, store, reopen: () => createStore({ pool: wrapPool(inner) }) };
};
const sqliteRows = (file, sql) => { const d = new DatabaseSync(file); try { return d.prepare(sql).all(); } finally { d.close(); } };
const userCols = 'id,email,name,password_hash,role,created_at,last_login_at,google_sub';

/* ═════════ 1. SQLite — the real driver ═════════ */
{
  const f = dbFile('fresh'); const s = await openSqlite(f);
  const a = await s.createFirstUser(A), b = await s.createFirstUser(B);
  ok('SQLITE 1. first admin creation on an empty database returns the new id', Number.isInteger(a) && a > 0, String(a));
  ok('SQLITE 2. a second setup attempt (a DIFFERENT e-mail) is denied: null, and exactly one user exists', b === null && (await s.userCount()) === 1);
  const row = sqliteRows(f, 'SELECT id, role, bootstrap FROM users')[0];
  ok('SQLITE 3. the first account carries the marker bootstrap = 1 and is the admin', row.bootstrap === 1 && row.role === 'admin' && row.id === a, JSON.stringify(row));
  const col = sqliteRows(f, "SELECT name, type, \"notnull\", dflt_value FROM pragma_table_info('users') WHERE name = 'bootstrap'")[0];
  ok('SQLITE 4. migration: users.bootstrap is a plain nullable INTEGER with no default (the existing additive convention)', !!col && col.type === 'INTEGER' && col.notnull === 0 && col.dflt_value == null, JSON.stringify(col));
  const idx = sqliteRows(f, "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'uq_users_one_bootstrap'")[0];
  ok('SQLITE 5. the index exists, is UNIQUE and PARTIAL (WHERE bootstrap = 1)', !!idx && /CREATE UNIQUE INDEX/i.test(idx.sql) && /WHERE bootstrap = 1/.test(idx.sql), idx && idx.sql);
  const e1 = await s.createUser({ email: 'invited-1@example.com', name: 'Invited 1', passwordHash: '', role: 'editor' });
  const e2 = await s.createUser({ email: 'invited-2@example.com', name: 'Invited 2', passwordHash: '', role: 'editor' });
  const nulls = sqliteRows(f, 'SELECT COUNT(*) AS n FROM users WHERE bootstrap IS NULL')[0].n;
  ok('SQLITE 6. invited users (createUser) are unaffected: any number may exist, all with bootstrap NULL, alongside the one marked account', !!e1 && !!e2 && nulls === 2 && (await s.userCount()) === 3 && (await s.userByEmail(A.email)).id === a);
  await s.close();
  const s2 = await openSqlite(f);
  ok('SQLITE 7. restart: initialising the same database again succeeds and changes nothing (3 users, one marker)', (await s2.userCount()) === 3 && sqliteRows(f, 'SELECT COUNT(*) AS n FROM users WHERE bootstrap = 1')[0].n === 1 && (await s2.createFirstUser(B)) === null);
  await s2.close();
}
{
  /* the database alone decides: NOT EXISTS neutralised */
  const f = dbFile('blind'); const s = await openSqlite(f);
  hook.blind = true; hook.rewrites = 0;
  const a = await s.createFirstUser(A); const b = await attempt(() => s.createFirstUser(B));
  hook.blind = false;
  ok('SQLITE 8. NOT EXISTS neutralised (a stale snapshot): the first attempt wins …', Number.isInteger(a) && hook.rewrites === 2);
  ok('SQLITE 9. … and the second, which now reaches the INSERT, is rejected BY THE INDEX and reported as null — not thrown — leaving exactly one user', !b.error && b.value === null && (await s.userCount()) === 1, b.error ? b.error.message : String(b.value));
  await s.close();
}
{
  /* unrelated uniqueness errors remain errors */
  const f = dbFile('unrelated'); const s = await openSqlite(f);
  await s.createUser({ email: A.email, name: 'Already Here', passwordHash: '', role: 'editor' });
  hook.blind = true; const r = await attempt(() => s.createFirstUser({ ...A })); hook.blind = false;
  ok('SQLITE 10. a violation of an UNRELATED unique constraint (users.email) is thrown, never mistaken for "first account taken"', !!r.error && /UNIQUE constraint failed: users\.email/.test(r.error.message) && (await s.userCount()) === 1, r.error ? r.error.message : String(r.value));
  await s.close();
}
{
  /* an existing database with users: legacy schema (no bootstrap column / index) */
  const f = dbFile('legacy'); let s = await openSqlite(f); await s.close();
  const raw = new DatabaseSync(f);
  raw.exec('DROP INDEX uq_users_one_bootstrap'); raw.exec('ALTER TABLE users DROP COLUMN bootstrap');
  raw.exec("INSERT INTO users (email,name,password_hash,role,created_at) VALUES ('legacy-admin@example.com','Legacy Admin','scrypt:old','admin','2020-01-01T00:00:00.000Z'), ('legacy-editor@example.com','Legacy Editor','scrypt:old2','editor','2020-02-02T00:00:00.000Z')");
  raw.close();
  const before = JSON.stringify(sqliteRows(f, `SELECT ${userCols} FROM users ORDER BY id`));
  s = await openSqlite(f);
  const after = JSON.stringify(sqliteRows(f, `SELECT ${userCols} FROM users ORDER BY id`));
  ok('SQLITE 11. LEGACY database with users: the new code migrates it; every existing user row is byte-for-byte unchanged', before === after && JSON.parse(after).length === 2);
  ok('SQLITE 12. …no existing user is assigned a bootstrap marker (all NULL), and the column and the index now exist', sqliteRows(f, 'SELECT COUNT(*) AS n FROM users WHERE bootstrap IS NOT NULL')[0].n === 0 && sqliteRows(f, "SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'uq_users_one_bootstrap'")[0].n === 1);
  ok('SQLITE 13. …setup stays closed: createFirstUser returns null and no user is added', (await s.createFirstUser(B)) === null && (await s.userCount()) === 2);
  await s.close(); s = await openSqlite(f);
  ok('SQLITE 14. …and a further restart is a no-op (rows still identical)', JSON.stringify(sqliteRows(f, `SELECT ${userCols} FROM users ORDER BY id`)) === before);
  await s.close();
}

/* ═════════ 2. error classification — which errors mean "the first account is taken" ═════════ */
{
  const { store } = await openMem();
  for (const [label, err, expectNull] of [
    ['PostgreSQL 23505 naming the bootstrap index', mk('duplicate key value violates unique constraint "uq_users_one_bootstrap"', { code: '23505', constraint: 'uq_users_one_bootstrap' }), true],
    ['SQLite "UNIQUE constraint failed: users.bootstrap"', mk('UNIQUE constraint failed: users.bootstrap', { code: 'ERR_SQLITE_ERROR', errcode: 2067 }), true],
    ['PostgreSQL 23505 naming users_email_key', mk('duplicate key value violates unique constraint "users_email_key"', { code: '23505', constraint: 'users_email_key' }), false],
    ['PostgreSQL 23505 naming users_pkey', mk('duplicate key value violates unique constraint "users_pkey"', { code: '23505', constraint: 'users_pkey' }), false],
    ['PostgreSQL 23505 naming the AUDIT index (a different table\'s index)', mk('duplicate key value violates unique constraint "uq_seo_audits_one_active_per_website"', { code: '23505', constraint: 'uq_seo_audits_one_active_per_website' }), false],
    ['an UNNAMED 23505 (pg-mem\'s shape — which constraint is unknown, so it is not assumed)', mk('duplicate key value violates unique constraint', { code: '23505' }), false],
    ['SQLite "UNIQUE constraint failed: users.email"', mk('UNIQUE constraint failed: users.email', { code: 'ERR_SQLITE_ERROR', errcode: 2067 }), false],
    ['SQLite "UNIQUE constraint failed: seo_audits.website_id"', mk('UNIQUE constraint failed: seo_audits.website_id', { code: 'ERR_SQLITE_ERROR' }), false],
    ['serialization failure 40001', mk('could not serialize access', { code: '40001' }), false],
    ['not-null violation 23502', mk('null value in column "email"', { code: '23502' }), false],
    ['statement timeout 57014', mk('canceling statement due to statement timeout', { code: '57014' }), false],
    ['a plain Error with no code', mk('connection terminated unexpectedly'), false],
  ]) {
    hook.failWith = err; const r = await attempt(() => store.createFirstUser(A)); hook.failWith = null;
    ok(`CLASSIFY. ${label} → ${expectNull ? 'null (the first account is taken)' : 'rethrown unchanged'}`, expectNull ? (!r.error && r.value === null) : (r.error === err), r.error ? r.error.message : String(r.value));
  }
}

/* ═════════ 3. pg-mem — the PostgreSQL adapter's SQL ═════════ */
{
  const m = await openMem();
  const a = await m.store.createFirstUser(A), b = await m.store.createFirstUser(B);
  ok('PG-MEM 1. first admin on an empty PostgreSQL-adapter database returns an id; a second setup attempt (different e-mail) is denied (null)', Number.isInteger(a) && b === null && (await m.store.userCount()) === 1);
  ok('PG-MEM 2. the first account carries bootstrap = 1; the column exists', (await m.inner.query('SELECT bootstrap FROM users')).rows[0].bootstrap === 1);
  const dup = await attempt(() => m.inner.query("INSERT INTO users (email,name,password_hash,role,created_at,bootstrap) VALUES ('x@example.com','X','h','admin','t',1)"));
  ok('PG-MEM 3. the partial unique index exists: a second row with bootstrap = 1 is refused by the database (23505) …', !!dup.error && dup.error.code === '23505');
  const okNull = await attempt(() => m.inner.query("INSERT INTO users (email,name,password_hash,role,created_at) VALUES ('y@example.com','Y','h','editor','t'), ('z@example.com','Z','h','editor','t')"));
  ok('PG-MEM 4. … while any number of rows with bootstrap NULL are allowed (invited users are unaffected)', !okNull.error && (await m.store.userCount()) === 3);
}
{
  const m = await openMem();
  hook.blind = true; hook.rewrites = 0;
  const a = await m.store.createFirstUser(A); const b = await attempt(() => m.store.createFirstUser(B));
  hook.blind = false;
  ok('PG-MEM 5. NOT EXISTS neutralised: the loser is rejected by the INDEX (23505 naming uq_users_one_bootstrap) and reported as null; one user remains', Number.isInteger(a) && !b.error && b.value === null && hook.rewrites === 2 && (await m.store.userCount()) === 1, b.error ? b.error.message : String(b.value));
}
{
  const m = await openMem();
  await m.store.createUser({ email: A.email, name: 'Already Here', passwordHash: '', role: 'editor' });
  hook.blind = true; const r = await attempt(() => m.store.createFirstUser({ ...A })); hook.blind = false;
  ok('PG-MEM 6. an unrelated unique violation (users_email_key) is thrown, not reported as null', !!r.error && r.error.code === '23505' && r.error.constraint === 'users_email_key' && (await m.store.userCount()) === 1, r.error ? r.error.message : String(r.value));
}
{
  const m = await openMem();
  await m.store.createFirstUser(A);
  hook.blind = true; hook.nameIt = false; const r = await attempt(() => m.store.createFirstUser(B)); hook.blind = false; hook.nameIt = true;
  ok('PG-MEM 7. pg-mem\'s raw UNNAMED 23505 is deliberately NOT swallowed: with no constraint name the code cannot tell which constraint fired, so the error surfaces (real PostgreSQL always names it)', !!r.error && r.error.code === '23505' && !r.error.constraint);
}
{
  /* an existing PostgreSQL-adapter database with users, then restart */
  const m = await openMem(true);
  await m.inner.query('DROP INDEX uq_users_one_bootstrap'); await m.inner.query('ALTER TABLE users DROP COLUMN bootstrap');
  await m.inner.query("INSERT INTO users (email,name,password_hash,role,created_at) VALUES ('legacy-admin@example.com','Legacy Admin','scrypt:old','admin','2020-01-01T00:00:00.000Z'), ('legacy-editor@example.com','Legacy Editor','scrypt:old2','editor','2020-02-02T00:00:00.000Z')");
  const before = JSON.stringify((await m.inner.query(`SELECT ${userCols} FROM users ORDER BY id`)).rows);
  const s2 = await attempt(() => m.reopen());
  const after = JSON.stringify((await m.inner.query(`SELECT ${userCols} FROM users ORDER BY id`)).rows);
  ok('PG-MEM 8. an existing database with users is migrated by the new code; every existing user row is unchanged and none gets a marker', !s2.error && before === after && (await m.inner.query('SELECT COUNT(*)::int AS n FROM users WHERE bootstrap IS NOT NULL')).rows[0].n === 0, s2.error ? s2.error.message : '');
  ok('PG-MEM 9. …the index is back in place (a marked duplicate is refused) and setup stays closed (null)', !!s2.value && (await s2.value.createFirstUser(B)) === null && !!(await attempt(() => m.inner.query("INSERT INTO users (email,name,password_hash,role,created_at,bootstrap) VALUES ('p@example.com','P','h','admin','t',1), ('q@example.com','Q','h','admin','t',1)"))).error);
}

/* ═════════ 4. the two callers over HTTP (SQLite, the real app in this process) ═════════ */
const { createApp } = await import(new URL('./app.js', import.meta.url).href);
class Client {
  constructor() { this.cookie = ''; }
  async req(base, method, path, body) {
    const headers = { 'X-Requested-With': 'hk-admin' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.cookie) headers.Cookie = this.cookie;
    const res = await fetch(base + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    for (const c of res.headers.getSetCookie?.() || []) { const [kv] = c.split(';'); const [k, v] = kv.split('='); this.cookie = v === '' ? '' : `${k}=${v}`; }
    let data = {}; try { data = await res.json(); } catch { /* no body */ }
    return { status: res.status, data };
  }
}
const startApp = async (tag, port) => { const f = dbFile(tag); process.env.SQLITE_PATH = f; process.env.PUBLIC_URL = `http://localhost:${port}`; const ctx = await createApp(); const server = await new Promise((r) => { const s = ctx.app.listen(port, () => r(s)); }); return { ...ctx, server, base: `http://localhost:${port}`, file: f }; };
const body = (i) => ({ name: `Setup ${i}`, email: `setup${i}@example.com`, password: `a-long-setup-password-${i}` });
{
  const app = await startApp('http-manual', 8861);
  const c1 = new Client(), c2 = new Client();
  const r1 = await c1.req(app.base, 'POST', '/api/auth/setup', body(1));
  const r2 = await c2.req(app.base, 'POST', '/api/auth/setup', body(2));
  ok('HTTP manual 1. first setup → 201 and an admin; a second setup (other e-mail) → 403 "already completed"', r1.status === 201 && r1.data.user.role === 'admin' && r2.status === 403 && /already been completed/i.test(r2.data.error || ''), JSON.stringify([r1.status, r2.status]));
  ok('HTTP manual 2. exactly one user, marked bootstrap = 1', (await app.store.userCount()) === 1 && sqliteRows(app.file, 'SELECT bootstrap FROM users')[0].bootstrap === 1);
  await new Promise((r) => app.server.close(r)); await app.store.close();
}
{
  const app = await startApp('http-manual-race', 8862);
  // the route's own userCount() check is only a courtesy; make it stale (every request saw "no users"), and neutralise NOT EXISTS: ONLY the database constraint is left to stop the others
  const realCount = app.store.userCount; app.store.userCount = async () => 0;
  hook.blind = true; hook.rewrites = 0;
  const outcomes = await Promise.all([1, 2, 3].map((i) => new Client().req(app.base, 'POST', '/api/auth/setup', body(i))));
  hook.blind = false; app.store.userCount = realCount;
  const codes = outcomes.map((o) => o.status).sort().join();
  ok('HTTP manual 3. THREE simultaneous setup requests with different e-mails, NOT EXISTS neutralised: exactly one 201, the others 403 (the database admits one)', codes === '201,403,403' && hook.rewrites === 3, `${codes} rewrites=${hook.rewrites}`);
  ok('HTTP manual 4. …and exactly one administrator exists', (await app.store.userCount()) === 1 && (await app.store.adminCount()) === 1);
  await new Promise((r) => app.server.close(r)); await app.store.close();
}
{
  /* Google: a tiny FAKE Google (authorize + token), exactly the shape server/test-google.mjs uses */
  const FAKE = 8864, CID = 'test-client-id.apps.example', CSECRET = 'test-secret';
  const pending = new Map();
  const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const fake = http.createServer((req, res) => {
    const u = new URL(req.url, `http://localhost:${FAKE}`);
    if (u.pathname === '/authorize') {
      const q = u.searchParams, code = randomBytes(12).toString('hex');
      pending.set(code, { email: q.get('as'), sub: q.get('sub'), name: q.get('name') || '', nonce: q.get('nonce') });
      res.writeHead(302, { Location: `${q.get('redirect_uri')}?code=${code}&state=${encodeURIComponent(q.get('state'))}` }); return res.end();
    }
    if (u.pathname === '/token' && req.method === 'POST') {
      let raw = ''; req.on('data', (d) => (raw += d)); req.on('end', () => {
        const f = new URLSearchParams(raw), e = pending.get(f.get('code')); pending.delete(f.get('code'));
        if (!e) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'invalid_grant' })); }
        const claims = { iss: `http://localhost:${FAKE}`, aud: CID, exp: Math.floor(Date.now() / 1000) + 300, iat: Math.floor(Date.now() / 1000), nonce: e.nonce, sub: e.sub, email: e.email, email_verified: true, name: e.name };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ access_token: 'x', token_type: 'Bearer', id_token: `${b64u({ alg: 'RS256' })}.${b64u(claims)}.sig` }));
      }); return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => fake.listen(FAKE, r));
  Object.assign(process.env, { GOOGLE_CLIENT_ID: CID, GOOGLE_CLIENT_SECRET: CSECRET, GOOGLE_AUTH_URL: `http://localhost:${FAKE}/authorize`, GOOGLE_TOKEN_URL: `http://localhost:${FAKE}/token`, GOOGLE_ISSUER: `http://localhost:${FAKE}` });
  const app = await startApp('http-google-race', 8863);
  // each "browser" does start → consent → holds its callback URL + state cookie; the two callbacks are then fired together
  const journey = async (email, sub) => {
    const start = await fetch(`${app.base}/api/auth/google/start`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'hk-admin' }, body: '{}' });
    const state = (start.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).find((c) => c.startsWith('hk_oauth='));
    const { url } = await start.json();
    const consent = await fetch(`${url}&as=${encodeURIComponent(email)}&sub=${sub}&name=Racer`, { redirect: 'manual' });
    return () => fetch(consent.headers.get('location'), { redirect: 'manual', headers: { Cookie: state } }).then((r) => r.headers.get('location'));
  };
  const cb1 = await journey('google-one@example.com', 'sub-one'), cb2 = await journey('google-two@example.com', 'sub-two');
  const realCount = app.store.userCount; app.store.userCount = async () => 0;     // the courtesy pre-check is stale for both callbacks; NOT EXISTS is neutralised too
  hook.blind = true; hook.rewrites = 0;
  const [l1, l2] = await Promise.all([cb1(), cb2()]);
  hook.blind = false; app.store.userCount = realCount;
  const errs = [l1, l2].map((l) => new URL(l, 'http://x').searchParams.get('auth_error'));
  ok('HTTP google 1. TWO simultaneous first-account Google sign-ins (different Google accounts), NOT EXISTS neutralised: exactly one lands in /admin, the other is refused (not_invited)', [l1, l2].filter((l) => l === '/admin').length === 1 && errs.filter((e) => e === 'not_invited').length === 1 && hook.rewrites === 2, JSON.stringify([l1, l2, hook.rewrites]));
  ok('HTTP google 2. …exactly one administrator exists, marked bootstrap = 1, linked to its Google identity', (await app.store.userCount()) === 1 && (await app.store.adminCount()) === 1 && sqliteRows(app.file, 'SELECT bootstrap, google_sub FROM users').every((r) => r.bootstrap === 1 && !!r.google_sub));
  await new Promise((r) => app.server.close(r)); await app.store.close(); await new Promise((r) => fake.close(r));
  for (const k of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_AUTH_URL', 'GOOGLE_TOKEN_URL', 'GOOGLE_ISSUER']) delete process.env[k];
}

/* ═════════ 5. the source, as written ═════════ */
{
  const raw = src('./db.js'), dbSrc = strip(raw);
  const fn = dbSrc.slice(dbSrc.indexOf('async createFirstUser'), dbSrc.indexOf('async userByEmail'));
  ok('SOURCE 1. createFirstUser keeps INSERT…SELECT…WHERE NOT EXISTS as the fast path and writes bootstrap = 1', /INSERT INTO users \(email,name,password_hash,role,created_at,bootstrap\) SELECT \?,\?,\?,\?,\?,1 WHERE NOT EXISTS \(SELECT 1 FROM users\)/.test(fn));
  ok('SOURCE 2. only the bootstrap-index violation is translated to null; everything else is rethrown', /catch \(err\) \{\s*if \(isBootstrapConflict\(err\)\) return null;\s*throw err;\s*\}/.test(fn));
  ok('SOURCE 3. the conflict test is narrow: SQLSTATE 23505 NAMING uq_users_one_bootstrap, or SQLite\'s users.bootstrap — nothing broader (no "unnamed" shortcut)', /const BOOTSTRAP_INDEX = 'uq_users_one_bootstrap';/.test(dbSrc) && /const isBootstrapConflict = \(err\) => err\?\.code === '23505'\s*\? err\.constraint === BOOTSTRAP_INDEX\s*: \/UNIQUE constraint failed: users\\\.bootstrap\\b\/\.test\(String\(err\?\.message\)\);/.test(dbSrc));
  ok('SOURCE 4. the column is added with the existing additive addColumn convention (nullable INTEGER, no NOT NULL / DEFAULT) and the index is a partial UNIQUE index on the marker', /await addColumn\('users', 'bootstrap', 'INTEGER'\);/.test(dbSrc) && /CREATE UNIQUE INDEX IF NOT EXISTS \$\{BOOTSTRAP_INDEX\} ON users \(bootstrap\) WHERE bootstrap = 1/.test(dbSrc));
  ok('SOURCE 5. a failing index build is retried and then THROWN (a server without the index must not look protected)', /for \(let attempt = 1; ; attempt\+\+\) \{\s*try \{ await db\.exec\(`CREATE UNIQUE INDEX IF NOT EXISTS \$\{BOOTSTRAP_INDEX\}[^`]*`\); break; \}\s*catch \(err\) \{\s*if \(attempt >= 3\) throw err;/.test(dbSrc));
  ok('SOURCE 6. only createFirstUser ever writes the marker; createUser is unchanged; no transaction, lock, ON CONFLICT or in-memory guard was introduced', (dbSrc.match(/\bbootstrap\b/g) || []).length > 0 && (dbSrc.match(/INSERT INTO users/g) || []).length === 2 && /INSERT INTO users \(email,name,password_hash,role,created_at\) VALUES \(\?,\?,\?,\?,\?\)/.test(dbSrc) && !/ON CONFLICT|BEGIN|COMMIT|ROLLBACK|FOR UPDATE|pg_advisory|LOCK TABLE|ISOLATION|Mutex|mutex/i.test(fn));
  ok('SOURCE 7. the comments no longer claim the bare INSERT…WHERE NOT EXISTS is atomic on its own (db.js, auth.js, google.js, README)', !/one atomic statement/i.test(raw) && !/One atomic INSERT/i.test(src('./auth.js')) && !/atomic: only ever succeeds once/.test(src('./google.js')) && !/one atomic SQL statement/.test(readFileSync(fileURLToPath(new URL('../README.md', import.meta.url)), 'utf8')));
  ok('SOURCE 8. both callers still turn null into the existing safe failure (setup: 403 "already completed"; Google: not_invited) and are otherwise unchanged', /if \(!id\) return res\.status\(403\)\.json\(\{ ok: false, error: 'Setup has already been completed\. Please sign in\.' \}\);/.test(src('./auth.js')) && /if \(!id\) return fail\('not_invited'\);/.test(src('./google.js')));
}

cleanup();
console.log(`\n${pass} passed, ${fail} failed`);
setTimeout(() => process.exit(fail ? 1 : 0), 300);
