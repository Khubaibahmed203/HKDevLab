// Phase 4 Hardening #6 — the shared database-backed rate limiter and the login / setup / password lock-out must hold under
// CONCURRENT requests. They used to "count, decide, then record" (and for logins "check, verify slowly, then record the failure"),
// so any burst of parallel requests all read the same old count and were all let through. Admission now records the hit FIRST and
// counts afterwards (see server/limits.js), so the limit is enforced by the database, not by the order requests happen to run in.
//
// What this does and does not prove: it runs the SAME limiter code against SQLite and against pg-mem (an in-memory PostgreSQL
// emulator). SQLite concurrency is exercised for real (separate async requests interleaving on one connection); pg-mem proves the
// SQL/API behave identically on the PostgreSQL adapter, but it is a single-threaded emulator and CANNOT produce PostgreSQL's
// multi-connection READ COMMITTED interleavings. Real PostgreSQL was not available, so real-PostgreSQL concurrency is NOT claimed.
// Run: node server/test-rate-limit-concurrency.mjs
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import express from 'express';
import { newDb } from 'pg-mem';

const DB = join(tmpdir(), 'hk-rate-limit-test.db');
for (const s of ['', '-wal', '-shm']) rmSync(DB + s, { force: true });
Object.assign(process.env, { SQLITE_PATH: DB, SMTP_HOST: '', SETUP_TOKEN: '', GOOGLE_CLIENT_ID: '', NODE_ENV: 'development' });
delete process.env.DATABASE_URL;

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { (cond ? pass++ : fail++); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };
const watchdog = setTimeout(() => { console.log('FAIL  watchdog: the test did not finish in time'); process.exit(1); }, 150_000);
watchdog.unref();

const { createStore } = await import(new URL('./db.js', import.meta.url).href);
const { createLimiter } = await import(new URL('./limits.js', import.meta.url).href);
const { createAuth, hashPassword } = await import(new URL('./auth.js', import.meta.url).href);
const { createSeoRouter } = await import(new URL('./seo/routes.js', import.meta.url).href);
const src = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const W = 15 * 60_000;
const yieldOnce = () => new Promise((r) => setImmediate(r));
const mulberry32 = (a) => () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const hashIp = (v) => createHash('sha256').update(`rl-test:${v}`).digest('hex').slice(0, 24);

/* ───────────── the two supported backends, each with a raw (store-independent) view of rate_events ───────────── */
async function sqliteBackend() {
  const store = await createStore();
  const rawDb = new DatabaseSync(DB);
  rawDb.exec('PRAGMA busy_timeout = 5000');
  return {
    label: 'sqlite', store,
    count: async (key) => Number(rawDb.prepare('SELECT COUNT(*) AS n FROM rate_events WHERE k = ?').get(key).n),
    backdate: async (key, ms) => { rawDb.prepare(`UPDATE rate_events SET ts = ts - ${Number(ms)} WHERE k = ?`).run(key); },
    close: async () => { rawDb.close(); await store.close(); },
  };
}
async function pgMemBackend() {
  const { Pool } = newDb().adapters.createPg();
  const pool = new Pool();
  const store = await createStore({ pool });
  return {
    label: 'pg-mem', store,
    count: async (key) => Number((await pool.query('SELECT COUNT(*) AS n FROM rate_events WHERE k = $1', [key])).rows[0].n),
    backdate: async (key, ms) => { await pool.query(`UPDATE rate_events SET ts = ts - ${Number(ms)} WHERE k = $1`, [key]); },
    close: async () => { await store.close(); },
  };
}

/** The store, but every rate_events call yields to the event loop a random (seeded, so reproducible) number of times before and
 *  after it — so concurrent callers interleave in many different orders instead of one fixed one. */
const jittered = (store, rand) => new Proxy(store, {
  get(target, prop) {
    const v = target[prop];
    if (!['rateHit', 'rateCount', 'rateRelease'].includes(prop)) return v;
    return async (...a) => {
      for (let i = Math.floor(rand() * 4); i > 0; i--) await yieldOnce();
      const r = await v.apply(target, a);
      for (let i = Math.floor(rand() * 4); i > 0; i--) await yieldOnce();
      return r;
    };
  },
});

/* ═════════════════════ PART A — the limiter primitive ═════════════════════ */
async function limiterSuite(b) {
  const { store, label, count, backdate } = b;
  const L = createLimiter(store);
  const t = (s) => `[${label}] ${s}`;
  const tally = (refusals) => ({ allowed: refusals.filter((r) => r === false).length, refused: refusals.filter((r) => r === true).length });

  // 1. sequential behaviour is unchanged: N allowed, then refused — and a refusal leaves nothing behind
  const seq = [];
  for (let i = 0; i < 6; i++) seq.push(await L.take('seq', 5, W));
  ok(t('A1. sequential, limit 5: calls 1-5 are allowed and call 6 is refused'), seq.slice(0, 5).every((r) => r === false) && seq[5] === true, seq.join());
  ok(t('A1. take() answers with a real boolean (false = allowed, true = refused) — never null/undefined'), seq.every((r) => r === true || r === false));
  for (let i = 0; i < 3; i++) await L.take('seq', 5, W);
  ok(t('A1. refused calls leave nothing behind: still exactly 5 stored hits after 4 refusals'), (await count('seq')) === 5, String(await count('seq')));

  // 2. THE invariant: far more concurrent callers than the limit can never be admitted beyond it
  const burst = tally(await Promise.all(Array.from({ length: 30 }, () => L.take('burst', 5, W))));
  const burstStored = await count('burst');
  console.log(`      ${label}: 30 concurrent take(max=5) -> allowed ${burst.allowed}, refused ${burst.refused}, persisted hits ${burstStored}`);
  ok(t('A2. 30 concurrent callers, limit 5: at most 5 are admitted'), burst.allowed <= 5, JSON.stringify(burst));
  ok(t('A2. …and every caller got an answer (allowed + refused = 30)'), burst.allowed + burst.refused === 30);
  ok(t('A3. the persisted hit count equals the number admitted and never exceeds the limit'), burstStored === burst.allowed && burstStored <= 5, `${burstStored} vs ${burst.allowed}`);

  // 2b. the same under many different (seeded) interleavings, not one lucky order
  let worst = 0, allTrials = true, storedMatches = true, anyAdmitted = false;
  for (let trial = 0; trial < 30; trial++) {
    const J = createLimiter(jittered(store, mulberry32(1000 + trial)));
    const key = `jitter-${trial}`;
    const r = tally(await Promise.all(Array.from({ length: 24 }, () => J.take(key, 5, W))));
    const stored = await count(key);
    worst = Math.max(worst, r.allowed);
    anyAdmitted ||= r.allowed > 0;
    if (r.allowed > 5 || r.allowed + r.refused !== 24) allTrials = false;
    if (stored !== r.allowed) storedMatches = false;
  }
  console.log(`      ${label}: 30 jittered trials x 24 concurrent callers (limit 5) -> worst-case admitted ${worst}`);
  ok(t('A2b. 30 seeded interleavings x 24 concurrent callers: never more than 5 admitted'), allTrials && worst <= 5, `worst ${worst}`);
  ok(t('A3b. …and in every trial the stored hits equal the admitted count'), storedMatches);

  // 3. liveness: concurrency that stays inside the allowance is never refused
  const within = tally(await Promise.all(Array.from({ length: 5 }, () => L.take('within', 5, W))));
  ok(t('A4. 5 concurrent callers with limit 5: all 5 are admitted (no spurious refusal inside the allowance)'), within.allowed === 5, JSON.stringify(within));
  for (let i = 0; i < 3; i++) await L.take('partial', 5, W);
  const partial = tally(await Promise.all(Array.from({ length: 10 }, () => L.take('partial', 5, W))));
  ok(t('A4. 3 used + 10 concurrent callers, limit 5: at most the 2 remaining are admitted, stored total never above 5'), partial.allowed <= 2 && (await count('partial')) === 3 + partial.allowed && (await count('partial')) <= 5, JSON.stringify(partial));
  for (let i = 0; i < 3; i++) await L.take('mixed', 5, W);
  const mixed = tally(await Promise.all([L.take('mixed', 5, W), L.take('mixed', 5, W)]));
  ok(t('A4. 3 used + 2 concurrent callers: both fit and are admitted; the next one is refused'), mixed.allowed === 2 && (await L.take('mixed', 5, W)) === true, JSON.stringify(mixed));

  // 3b. the boundary itself: with ONE slot left, overlapping callers must not both take it (each sees the other's hit, so count = max + 1)
  for (let i = 0; i < 4; i++) await L.take('lastslot', 5, W);
  const lastSlot = tally(await Promise.all([L.take('lastslot', 5, W), L.take('lastslot', 5, W)]));
  ok(t('A4b. one slot left and 2 concurrent callers: at most ONE is admitted and the stored hits never exceed 5 (the boundary is race-safe)'), lastSlot.allowed <= 1 && (await count('lastslot')) === 4 + lastSlot.allowed && (await count('lastslot')) <= 5, JSON.stringify(lastSlot));
  let edgeOk = true, edgeStored = true;
  for (let trial = 0; trial < 20; trial++) {
    const key = `edge-${trial}`;
    for (let i = 0; i < 4; i++) await L.take(key, 5, W);
    const J = createLimiter(jittered(store, mulberry32(5000 + trial)));
    const r = tally(await Promise.all(Array.from({ length: 6 }, () => J.take(key, 5, W))));
    if (r.allowed > 1) edgeOk = false;
    if ((await count(key)) !== 4 + r.allowed || (await count(key)) > 5) edgeStored = false;
  }
  ok(t('A4b. …and across 20 seeded interleavings (4 used + 6 concurrent callers): never more than the 1 remaining slot is admitted'), edgeOk);
  ok(t('A4b. …with the stored hits equal to the used slots plus the admitted ones, never above 5'), edgeStored);

  // 4. window semantics: hits that have aged out stop counting, and do not block the key for good
  for (let i = 0; i < 5; i++) await L.take('win', 5, W);
  ok(t('A5. window: a full key is refused'), (await L.take('win', 5, W)) === true);
  await backdate('win', W - 60_000);
  ok(t('A5. window: hits just INSIDE the window still count (still refused)'), (await L.take('win', 5, W)) === true);
  await backdate('win', 120_000);
  const afterExpiry = [];
  for (let i = 0; i < 6; i++) afterExpiry.push(await L.take('win', 5, W));
  ok(t('A5. window: once the hits have aged out the key is not blocked for good — the full allowance is back (5 allowed, then refused)'), afterExpiry.slice(0, 5).every((r) => r === false) && afterExpiry[5] === true, afterExpiry.join());

  // 5. independent keys
  for (let i = 0; i < 6; i++) await L.take('key-a', 5, W);
  ok(t('A6. key A is exhausted'), (await L.take('key-a', 5, W)) === true);
  const bSeq = []; for (let i = 0; i < 5; i++) bSeq.push(await L.take('key-b', 5, W));
  ok(t('A6. …and key B still has its full, separate allowance'), bSeq.every((r) => r === false), bSeq.join());
  const calls = [];
  for (let i = 0; i < 25; i++) calls.push(L.take('mix-a', 5, W).then((r) => ['a', r]));
  for (let i = 0; i < 5; i++) calls.push(L.take('mix-b', 5, W).then((r) => ['b', r]));
  const res = await Promise.all(calls);
  const a = res.filter(([k]) => k === 'a').map(([, r]) => r), bb = res.filter(([k]) => k === 'b').map(([, r]) => r);
  ok(t('A6. a burst on key A cannot use up key B: B\'s 5 concurrent calls are all admitted, A never exceeds 5'), bb.every((r) => r === false) && a.filter((r) => r === false).length <= 5, `a=${a.filter((r) => r === false).length} b=${bb.filter((r) => r === false).length}`);
  ok(t('A6. stored hits per key match what each key admitted'), (await count('mix-a')) === a.filter((r) => r === false).length && (await count('mix-b')) === 5);

  // 6. reserve / release
  const r1 = await L.reserve('slots', 2, W), r2 = await L.reserve('slots', 2, W), r3 = await L.reserve('slots', 2, W);
  ok(t('A7. reserve(): admitted callers get a slot object, the refused one gets null'), r1 && r2 && r3 === null && Number.isInteger(r1.id) && r1.id !== r2.id, JSON.stringify([r1, r2, r3]));
  ok(t('A7. a refused reserve leaves nothing behind (2 stored hits)'), (await count('slots')) === 2);
  await L.release(r1);
  ok(t('A7. release() gives back exactly that slot: one stored hit left, and the key admits one more'), (await count('slots')) === 1 && (await L.reserve('slots', 2, W)) !== null && (await L.reserve('slots', 2, W)) === null);
  await L.release(null, undefined); await L.release(r1); await L.release(r1);
  ok(t('A7. releasing null/undefined, or the same slot twice, is harmless and never removes anybody else\'s hit'), (await count('slots')) === 2);
  // 7. a flood against an already-full key is refused with reads only: no hit is written (a write would consume a row id even if deleted again)
  const fullSlots = []; for (let i = 0; i < 5; i++) fullSlots.push(await L.reserve('full', 5, W));
  for (let i = 0; i < 10; i++) await L.take('full', 5, W);
  await L.release(fullSlots[4]);
  const nextSlot = await L.reserve('full', 5, W);
  ok(t('A9. a flood against a full key writes nothing: 10 refusals consumed no row id (the next admitted slot id follows the last one)'), nextSlot && nextSlot.id === fullSlots[4].id + 1, `${fullSlots[4].id} -> ${nextSlot && nextSlot.id}`);
  await L.take('forget-me', 5, W); await L.take('keep-me', 5, W);
  await L.clear('forget-me');
  ok(t('A8. clear() forgets only the named key'), (await count('forget-me')) === 0 && (await count('keep-me')) === 1);
}

/* ═════════════════════ PART B — the real auth router (login / setup / password) over HTTP ═════════════════════ */
async function authSuite(b) {
  const { store, label, count } = b;
  const t = (s) => `[${label}] ${s}`;
  const limiter = createLimiter(store);
  // an infrastructure failure inside login must not count as a guess
  const failing = new Set();
  const flaky = new Proxy(store, { get(target, prop) { if (prop === 'userByEmail') return async (e) => { if (failing.has(e)) throw new Error('simulated database failure'); return target.userByEmail(e); }; return target[prop]; } });
  const auth = createAuth(flaky, { isProd: false, originAllowed: () => true, hashIp, limiter });
  const app = express();
  app.set('trust proxy', 1);
  app.use('/api/auth', (req, res, next) => auth.authenticate(req, res, next), auth.router);
  app.use((err, req, res, next) => res.status(500).json({ ok: false }));
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, body, { ip, cookie } = {}) => {
    const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'hk-admin', 'x-forwarded-for': ip || '203.0.113.250', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
    let data = {}; try { data = await res.json(); } catch { /* no body */ }
    return { status: res.status, data, cookie: (res.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ') };
  };
  const mk = async (email, password) => store.createUser({ email, name: 'Rate Test', passwordHash: await hashPassword(password), role: 'editor' });
  const GOOD = 'a-long-test-password-1', WRONG = (i) => `wrong-guess-number-${i}-xx`;
  const emKey = (email) => `em:${hashIp(email)}`, ipKey = (ip) => `ip:${hashIp(ip)}`;
  const statuses = (rs) => rs.map((r) => r.status);

  /* ── setup (first admin): only a WRONG setup key counts against the 8-per-15-minutes limit ── */
  const SETUP_KEY = 'the-correct-setup-key-123';
  process.env.SETUP_TOKEN = SETUP_KEY;
  const wrongSetup = (ip, i) => post('/api/auth/setup', { token: `nope-${i}`, name: 'Owner One', email: 'owner@example.com', password: GOOD }, { ip });
  const s1 = []; for (let i = 0; i < 9; i++) s1.push(await wrongSetup('198.51.100.1', i));
  ok(t('B1. setup, sequential: 8 wrong setup keys -> 403, the 9th is locked out (429)'), statuses(s1).slice(0, 8).every((x) => x === 403) && s1[8].status === 429, statuses(s1).join());
  ok(t('B1. …exactly 8 hits are stored (the refused 9th left nothing)'), (await count(`setup:${hashIp('198.51.100.1')}`)) === 8);
  const s2 = await Promise.all(Array.from({ length: 20 }, (_, i) => wrongSetup('198.51.100.2', i)));
  const s2wrong = s2.filter((r) => r.status === 403).length;
  console.log(`      ${label}: 20 concurrent wrong setup keys (limit 8) -> verified ${s2wrong}, locked out ${s2.filter((r) => r.status === 429).length}, persisted ${await count(`setup:${hashIp('198.51.100.2')}`)}`);
  ok(t('B2. setup, 20 concurrent wrong keys: at most 8 are even examined, the rest are 429, nothing was created'), s2wrong <= 8 && s2.every((r) => r.status === 403 || r.status === 429) && (await store.userCount()) === 0, statuses(s2).join());
  ok(t('B2. …and the stored hits equal the number of wrong keys that were examined'), (await count(`setup:${hashIp('198.51.100.2')}`)) === s2wrong);
  await wrongSetup('198.51.100.3', 1); await wrongSetup('198.51.100.3', 2);
  const created = await post('/api/auth/setup', { token: SETUP_KEY, name: 'Owner One', email: 'owner@example.com', password: GOOD }, { ip: '198.51.100.3' });
  ok(t('B3. setup with the CORRECT key succeeds and is not counted as a failure (only the 2 wrong ones remain stored)'), created.status === 201 && (await count(`setup:${hashIp('198.51.100.3')}`)) === 2, `${created.status} ${await count(`setup:${hashIp('198.51.100.3')}`)}`);
  const closed = await post('/api/auth/setup', { token: SETUP_KEY, name: 'Late One', email: 'late@example.com', password: GOOD }, { ip: '198.51.100.4' });
  ok(t('B3. once setup is complete it answers 403 and records nothing'), closed.status === 403 && (await count(`setup:${hashIp('198.51.100.4')}`)) === 0);
  process.env.SETUP_TOKEN = '';

  /* ── login: 5 failed attempts per account per 15 minutes (and 10 per IP) ── */
  await mk('seq@example.com', GOOD);
  const lseq = []; for (let i = 0; i < 6; i++) lseq.push(await post('/api/auth/login', { email: 'seq@example.com', password: WRONG(i) }, { ip: `10.1.0.${i}` }));
  const lok = await post('/api/auth/login', { email: 'seq@example.com', password: GOOD }, { ip: '10.1.0.99' });
  ok(t('B4. login, sequential: 5 wrong guesses -> 401, the 6th is locked out (429), and even the CORRECT password is refused while locked'), statuses(lseq).slice(0, 5).every((x) => x === 401) && lseq[5].status === 429 && lok.status === 429, `${statuses(lseq).join()} / ${lok.status}`);
  ok(t('B4. …exactly 5 failures are stored for the account'), (await count(emKey('seq@example.com'))) === 5);
  ok(t('B4. …the refused attempts did not touch the IP counters (only the 5 admitted attempts did)'), (await count(ipKey('10.1.0.5'))) === 0 && (await count(ipKey('10.1.0.99'))) === 0);

  await mk('burst@example.com', GOOD);
  const lburst = await Promise.all(Array.from({ length: 40 }, (_, i) => post('/api/auth/login', { email: 'burst@example.com', password: WRONG(i) }, { ip: `10.2.0.${i}` })));
  const verified = lburst.filter((r) => r.status === 401).length, lockedOut = lburst.filter((r) => r.status === 429).length;
  const burstStored = await count(emKey('burst@example.com'));
  console.log(`      ${label}: 40 concurrent wrong logins, one account (limit 5) -> verified ${verified}, locked out ${lockedOut}, persisted failures ${burstStored}`);
  ok(t('B5. login, 40 concurrent wrong guesses on ONE account: at most 5 are ever checked, everything else is 429 (before: all 40 were checked)'), verified <= 5 && verified + lockedOut === 40, statuses(lburst).join());
  ok(t('B5. …the persisted failure count equals the guesses that were checked and never exceeds 5'), burstStored === verified && burstStored <= 5, `${burstStored} vs ${verified}`);

  const ipBurst = await Promise.all(Array.from({ length: 30 }, (_, i) => post('/api/auth/login', { email: `nobody${i}@example.com`, password: WRONG(i) }, { ip: '10.3.0.1' })));
  const ipVerified = ipBurst.filter((r) => r.status === 401).length;
  ok(t('B6. login, 30 concurrent guesses from ONE IP (30 different accounts): at most 10 are checked'), ipVerified <= 10 && ipBurst.every((r) => r.status === 401 || r.status === 429), statuses(ipBurst).join());
  ok(t('B6. …the stored IP failures equal the number checked'), (await count(ipKey('10.3.0.1'))) === ipVerified, `${await count(ipKey('10.3.0.1'))} vs ${ipVerified}`);

  await mk('fine@example.com', GOOD);
  for (let i = 0; i < 3; i++) await post('/api/auth/login', { email: 'fine@example.com', password: WRONG(i) }, { ip: `10.4.0.${i}` });
  const good = await post('/api/auth/login', { email: 'fine@example.com', password: GOOD }, { ip: '10.4.0.50' });
  ok(t('B7. a CORRECT login succeeds and is not recorded as a failure: no IP hit left, and the account\'s earlier failures are cleared'), good.status === 200 && !!good.cookie && (await count(ipKey('10.4.0.50'))) === 0 && (await count(emKey('fine@example.com'))) === 0, `${good.status} ip=${await count(ipKey('10.4.0.50'))} em=${await count(emKey('fine@example.com'))}`);
  const after = []; for (let i = 0; i < 6; i++) after.push(await post('/api/auth/login', { email: 'fine@example.com', password: WRONG(i) }, { ip: `10.4.1.${i}` }));
  ok(t('B7. …and after the success the full 5-attempt allowance is back (5 x 401 then 429)'), statuses(after).slice(0, 5).every((x) => x === 401) && after[5].status === 429, statuses(after).join());

  failing.add('boom@example.com');
  const boom = await post('/api/auth/login', { email: 'boom@example.com', password: GOOD }, { ip: '10.5.0.1' });
  ok(t('B8. an error inside login (not a guess) records no failure on either key'), boom.status === 500 && (await count(ipKey('10.5.0.1'))) === 0 && (await count(emKey('boom@example.com'))) === 0, `${boom.status}`);

  /* ── change password: 5 wrong "current password" attempts per user per 15 minutes ── */
  const uPw = await mk('pw@example.com', GOOD);
  const loggedIn = await post('/api/auth/login', { email: 'pw@example.com', password: GOOD }, { ip: '10.6.0.1' });
  const pwKey = `pw:${uPw}`;
  const shortNext = await post('/api/auth/password', { current: GOOD, next: 'short' }, { cookie: loggedIn.cookie, ip: '10.6.0.2' });
  ok(t('B9. change password with the CORRECT current password is not counted as a failure (even when the new password is rejected)'), loggedIn.status === 200 && shortNext.status === 400 && !!shortNext.data.errors?.next && (await count(pwKey)) === 0, `${shortNext.status} ${await count(pwKey)}`);
  const pseq = []; for (let i = 0; i < 6; i++) pseq.push(await post('/api/auth/password', { current: WRONG(i), next: 'another-long-password-9' }, { cookie: loggedIn.cookie, ip: '10.6.0.3' }));
  ok(t('B9. change password, sequential: 5 wrong -> 400, the 6th is 429'), statuses(pseq).slice(0, 5).every((x) => x === 400 && pseq[0].data.errors?.current) && pseq[5].status === 429, statuses(pseq).join());

  const uPw2 = await mk('pw2@example.com', GOOD);
  const li2 = await post('/api/auth/login', { email: 'pw2@example.com', password: GOOD }, { ip: '10.6.1.1' });
  const pburst = await Promise.all(Array.from({ length: 30 }, (_, i) => post('/api/auth/password', { current: WRONG(i), next: 'another-long-password-9' }, { cookie: li2.cookie, ip: '10.6.1.2' })));
  const pChecked = pburst.filter((r) => r.status === 400).length;
  ok(t('B10. change password, 30 concurrent wrong attempts: at most 5 are checked, the rest are 429, and the stored count matches'), pChecked <= 5 && pburst.every((r) => r.status === 400 || r.status === 429) && (await count(`pw:${uPw2}`)) === pChecked, `${pChecked} stored ${await count(`pw:${uPw2}`)}`);

  await new Promise((r) => server.close(r));
}

/* ═════════════════════ PART C — the SEO routes go through the same limiter, with the same thresholds ═════════════════════ */
async function seoRoutesSuite(b) {
  const { store, label, count } = b;
  const t = (s) => `[${label}] ${s}`;
  const limiter = createLimiter(store);
  let uid = 100;
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: +req.get('x-test-user'), email: 'rate@example.com', role: 'admin' }; next(); });
  app.use('/api/admin/seo', createSeoRouter(store, { limiter }));
  app.use((err, req, res, next) => res.status(500).json({ ok: false }));
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, user, body = {}) => (await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-user': String(user) }, body: JSON.stringify(body) })).status;
  // each route claims its slot BEFORE looking anything up, so an unknown id / website (404) is a cheap, side-effect-free way to spend one
  const routes = [
    ['apply', '/api/admin/seo/recommendations/999999/apply', {}, 20],
    ['recommend', '/api/admin/seo/issues/999999/recommend', {}, 20],
    ['scan', '/api/admin/seo/scan', { websiteId: 999999 }, 10],
  ];
  for (const [name, path, body, limit] of routes) {
    const user = uid++;
    const seq = []; for (let i = 0; i < limit + 1; i++) seq.push(await call(path, user, body));
    ok(t(`C1. SEO ${name}: ${limit} sequential requests are admitted (404 = past the limiter), the next is 429`), seq.slice(0, limit).every((s) => s === 404) && seq[limit] === 429, seq.join());
    ok(t(`C1. …and exactly ${limit} hits are stored for that user`), (await count(`seo-${name}:${user}`)) === limit, String(await count(`seo-${name}:${user}`)));
    const burstUser = uid++;
    const burst = await Promise.all(Array.from({ length: limit * 2 }, () => call(path, burstUser, body)));
    const admitted = burst.filter((s) => s === 404).length;
    ok(t(`C2. SEO ${name}: ${limit * 2} concurrent requests -> at most ${limit} admitted, the rest 429, stored hits match`), admitted <= limit && burst.every((s) => s === 404 || s === 429) && (await count(`seo-${name}:${burstUser}`)) === admitted, `${admitted} stored ${await count(`seo-${name}:${burstUser}`)}`);
  }
  await new Promise((r) => server.close(r));
}

/* ═════════════════════ run ═════════════════════ */
for (const make of [sqliteBackend, pgMemBackend]) {
  const b = await make();
  await limiterSuite(b);
  await authSuite(b);
  await seoRoutesSuite(b);
  await b.close();
}

/* ═════════════════════ PART D — what changed and what did not (source) ═════════════════════ */
{
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
  const limitsSrc = strip(src('./limits.js')), authSrc = strip(src('./auth.js')), appSrc = src('./app.js'), googleSrc = src('./google.js'), routesSrc = src('./seo/routes.js'), dbSrc = strip(src('./db.js'));
  const reserve = limitsSrc.slice(limitsSrc.indexOf('async function reserve'), limitsSrc.lastIndexOf('return {'));
  ok('D1. limits.js reserve(): the admission decision (`count <= max`) is made on a count taken AFTER the request\'s own hit was recorded', reserve.indexOf('rateHit(') > 0 && reserve.indexOf('rateHit(') < reserve.indexOf('<= max') && /rateCount\([^)]*\)\) <= max/.test(reserve), reserve);
  ok('D1. limits.js: an over-limit request gives its own hit back by id, and the only count BEFORE the hit is a refuse-only shortcut (`>= max` returns null)', /rateRelease\(id\)/.test(reserve) && /rateCount\([^)]*\)\) >= max\) return null;\s*const id = await store\.rateHit/.test(reserve) && (reserve.match(/>= max/g) || []).length === 1);
  ok('D1. limits.js: no in-memory lock, mutex or counter is the guarantee (the database is)', !/Mutex|mutex|Map\(|new Set\(|\bqueue\b|semaphore/i.test(limitsSrc));
  ok('D2. the racy blocked()/fail() primitives are gone, and nothing calls them any more', !/\bblocked\b|\bfail\s*\(/.test(limitsSrc) && !/limiter\.(blocked|fail)\(/.test(authSrc + appSrc + googleSrc + routesSrc));
  ok('D2. every admission goes through reserve()/take(): login, setup and change-password use reserve(); the rest use take()', (authSrc.match(/limiter\.reserve\(/g) || []).length === 4 && /limiter\.take\(/.test(appSrc) && /limiter\.take\(/.test(googleSrc) && /limiter\.take\(/.test(routesSrc));
  // thresholds, windows and keys are exactly what they were
  ok('D3. contact: 5 per 15 minutes on c:<ip>', /limiter\.take\(`c:\$\{ipHash\}`, 5, 15 \* 60_000\)/.test(appSrc));
  ok('D3. media upload: 30 per 10 minutes on m:<user>', /limiter\.take\(`m:\$\{req\.user\.id\}`, 30, 10 \* 60_000\)/.test(appSrc));
  ok('D3. Google start 20 and callback 30 per 15 minutes (gs:/gc:)', /limited\(`gs:\$\{hashIp\(req\.ip\)\}`, 20\)/.test(googleSrc) && /limited\(`gc:\$\{hashIp\(req\.ip\)\}`, 30\)/.test(googleSrc) && /limiter\.take\(key, max, 15 \* 60_000\)/.test(googleSrc));
  ok('D3. SEO: scan 10, recommend 20, apply 20 per 10 minutes, on the same keys', /limiter\.take\(`seo-scan:\$\{req\.user\.id\}`, 10, 10 \* 60_000\)/.test(routesSrc) && /limiter\.take\(`seo-recommend:\$\{req\.user\.id\}`, 20, 10 \* 60_000\)/.test(routesSrc) && /limiter\.take\(`seo-apply:\$\{req\.user\.id\}`, 20, 10 \* 60_000\)/.test(routesSrc));
  ok('D3. auth: window 15 minutes; login 10 per IP and 5 per account; setup 8; change-password 5 — same keys', /const WIN = 15 \* 60_000/.test(authSrc) && /reserve\(ipK, 10, WIN\)/.test(authSrc) && /reserve\(emK, 5, WIN\)/.test(authSrc) && /reserve\(ip, 8, WIN\)/.test(authSrc) && /reserve\(`pw:\$\{req\.user\.id\}`, 5, WIN\)/.test(authSrc) && /ipK = `ip:\$\{hashIp\(req\.ip\)\}`, emK = `em:\$\{hashIp\(email\)\}`/.test(authSrc) && /ip = `setup:\$\{hashIp\(req\.ip\)\}`/.test(authSrc));
  ok('D4. the login still verifies the password exactly where it did (the scrypt cost and password policy are untouched)', /N: 16384, r: 8, p: 1/.test(authSrc) && /pw\.length < 10/.test(authSrc));
  ok('D5. no schema change and no transaction: db.js adds no table, column or index, and still has no transaction/lock code', !/CREATE TABLE IF NOT EXISTS rate_/.test(dbSrc.replace(/CREATE TABLE IF NOT EXISTS rate_events/, '')) && !/BEGIN|COMMIT|ROLLBACK|FOR UPDATE|pg_advisory|LOCK TABLE/i.test(dbSrc) && (dbSrc.match(/ADD COLUMN/g) || []).length === 2);
  ok('D5. rateRelease deletes by primary key only (it can never remove another caller\'s hit)', /DELETE FROM rate_events WHERE id = \?/.test(dbSrc));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.on('exit', () => { for (const s of ['', '-wal', '-shm']) { try { rmSync(DB + s, { force: true }); } catch { /* temp file, harmless */ } } });
setTimeout(() => process.exit(fail ? 1 : 0), 300);
