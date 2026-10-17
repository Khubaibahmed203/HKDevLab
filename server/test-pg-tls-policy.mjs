// TLS policy of the PostgreSQL connection that db.js builds from DATABASE_URL — proven WITHOUT any database or network:
//  • pg.Pool is replaced by a recording fake (pg-mem answers the queries), so the REAL createStore → pgAdapter path runs and the exact options it hands to `new pg.Pool` are read;
//  • the TLS that pg would then really use is resolved with `new pg.Client(thoseOptions).connectionParameters.ssl` — the same merge pg-pool performs when it opens a client —
//    and `.connect()` is booby-trapped, so a test that ever dialled would fail instead of connecting. All hosts and credentials are synthetic (`.invalid` is a reserved TLD).
// Run: node server/test-pg-tls-policy.mjs
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { newDb } from 'pg-mem';
import { createStore } from './db.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { (cond ? pass++ : fail++); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };
const watchdog = setTimeout(() => { console.log('FAIL  watchdog: the test did not finish in time'); process.exit(1); }, 120_000);
watchdog.unref();

// a developer's own PG* variables must not leak into the resolution of the synthetic URLs
for (const k of Object.keys(process.env)) if (/^PG/i.test(k) || /^HKDEV_TEST_PG/i.test(k)) delete process.env[k];

const SECRET = 'fakepass', HOST = 'db.example.invalid', USER = 'fakeuser';
const BASE = `postgres://${USER}:${SECRET}@${HOST}:5432/fakedb`;

/* ── instruments ── */
let connects = 0;
const realConnect = pg.Client.prototype.connect;
pg.Client.prototype.connect = function () { connects++; throw new Error('connect() must never be called by this test'); };

const recorded = [], instances = [];
const RealPool = pg.Pool;
class RecordingPool extends EventEmitter {
  constructor(opts) { super(); recorded.push(opts); instances.push(this); const { Pool } = newDb().adapters.createPg(); this.inner = new Pool(); }
  query(...a) { return this.inner.query(...a); }
  end() { return this.inner.end(); }
  connect() { connects++; throw new Error('connect() must never be called by this test'); }
}
pg.Pool = RecordingPool;

const captured = [];
const quiet = async (fn) => {
  const o = { log: console.log, error: console.error, warn: console.warn };
  for (const k of Object.keys(o)) console[k] = (...a) => captured.push(a.map(String).join(' '));
  try { return await fn(); } finally { Object.assign(console, o); }
};
const warnings = [];
process.on('warning', (w) => warnings.push(String(w.message)));

/** What pg would hand to tls.connect, classified. */
const tlsOf = (ssl) => {
  if (!ssl) return 'off';
  if (ssl === true) return 'verified';
  if (ssl.rejectUnauthorized === false) return 'encrypted-NOT-verified';
  if (typeof ssl.checkServerIdentity === 'function') return 'chain-only-hostname-NOT-checked';
  return 'verified';
};
/** The option db.js passed to `new pg.Pool` (before the URL's own options are merged over it). */
const optionOf = (ssl) => (!ssl ? 'off' : ssl.rejectUnauthorized === true && Object.keys(ssl).length === 1 ? 'verified' : 'other:' + JSON.stringify(ssl));

async function run(url, env = {}) {
  const keys = ['DATABASE_URL', ...Object.keys(env)], saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, env, { DATABASE_URL: url });
  const before = recorded.length;
  let store, probe = null;
  try {
    store = await quiet(() => createStore());
    try { probe = new pg.Client(recorded[before]); } catch { /* an unparseable URL cannot be resolved by pg either (while the env of this case is still set) */ }   // pg's own merge of the URL over the option; never connected
  } finally { for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
  const opts = recorded[before];
  const out = { pools: recorded.length - before, opts, option: optionOf(opts?.ssl), tls: probe ? tlsOf(probe.connectionParameters.ssl) : 'unresolvable', dest: probe ? probe.host : undefined, pool: instances[before] };
  await store.close();
  return out;
}
const expectCase = async (label, url, want, env) => {
  let got; try { got = await run(url, env); } catch (e) { ok(label, false, 'threw ' + (e.code || e.name)); return null; }
  const good = got.pools === 1 && got.option === want.option && got.tls === want.tls && (want.dest === undefined || got.dest === want.dest);
  ok(`${label}  →  code option ${want.option}, effective TLS ${want.tls}${want.dest !== undefined ? `, destination ${JSON.stringify(want.dest)}` : ''}`, good, JSON.stringify({ pools: got.pools, option: got.option, tls: got.tls, dest: got.dest }));
  return got;
};
const V = { option: 'verified', tls: 'verified' };

try {
  /* 0. the harness itself: db.js really builds its pool through the substituted pg.Pool, with the policy option */
  const first = await expectCase('control: a remote URL without any ssl option', BASE, V);
  ok('control: db.js reached the recording pool (the real createStore path ran, nothing was dialled)', recorded.length === 1 && connects === 0);

  /* 1. remote databases: verified TLS, whatever the URL says about sslmode=require / verify-full */
  await expectCase('remote, sslmode=require (the production form)', `${BASE}?sslmode=require`, V);
  await expectCase('remote, sslmode=verify-full', `${BASE}?sslmode=verify-full`, V);
  await expectCase('remote, sslmode=prefer (pg 8 treats it as verify-full)', `${BASE}?sslmode=prefer`, V);
  await expectCase('remote, sslmode=verify-ca (pg 8 treats it as verify-full)', `${BASE}?sslmode=verify-ca`, V);
  await expectCase('remote, sslmode=require&channel_binding=require', `${BASE}?sslmode=require&channel_binding=require`, V);
  await expectCase('remote, ssl=true', `${BASE}?ssl=true`, V);
  await expectCase('remote, uselibpqcompat=true&sslmode=verify-full', `${BASE}?uselibpqcompat=true&sslmode=verify-full`, V);

  /* 2. explicit URL options are applied by pg on top and left unchanged: the insecure ones are identified as insecure, not presented as secure */
  await expectCase('EXPLICIT INSECURE sslmode=no-verify: encrypted but NOT verified (operator choice kept)', `${BASE}?sslmode=no-verify`, { option: 'verified', tls: 'encrypted-NOT-verified' });
  await expectCase('EXPLICIT INSECURE ssl=no-verify: encrypted but NOT verified', `${BASE}?ssl=no-verify`, { option: 'verified', tls: 'encrypted-NOT-verified' });
  await expectCase('EXPLICIT INSECURE uselibpqcompat=true&sslmode=require: libpq semantics, NOT verified', `${BASE}?uselibpqcompat=true&sslmode=require`, { option: 'verified', tls: 'encrypted-NOT-verified' });
  await expectCase('EXPLICIT INSECURE uselibpqcompat=true&sslmode=prefer: NOT verified', `${BASE}?uselibpqcompat=true&sslmode=prefer`, { option: 'verified', tls: 'encrypted-NOT-verified' });
  await expectCase('EXPLICIT INSECURE sslmode=disable: plaintext (operator choice kept)', `${BASE}?sslmode=disable`, { option: 'verified', tls: 'off' });
  await expectCase('EXPLICIT INSECURE ssl=0: plaintext', `${BASE}?ssl=0`, { option: 'verified', tls: 'off' });

  /* 3. loopback destinations: no TLS required, as before (and an explicit sslmode in the URL still wins) */
  await expectCase('loopback: localhost', 'postgres://fakeuser:fakepass@localhost:5432/fakedb', { option: 'off', tls: 'off', dest: 'localhost' });
  await expectCase('loopback: 127.0.0.1', 'postgres://fakeuser:fakepass@127.0.0.1:5432/fakedb', { option: 'off', tls: 'off', dest: '127.0.0.1' });
  await expectCase('loopback: IPv6 [::1] (pg reports the bracketed form)', 'postgres://fakeuser:fakepass@[::1]:5432/fakedb', { option: 'off', tls: 'off', dest: '[::1]' });
  await expectCase('loopback: IPv6 given as ?host=::1', `${BASE}?host=::1`, { option: 'off', tls: 'off', dest: '::1' });
  await expectCase('loopback: upper-case LOCALHOST (host names are case-insensitive)', 'postgres://fakeuser:fakepass@LOCALHOST:5432/fakedb', { option: 'off', tls: 'off' });
  await expectCase('loopback: no host in the URL (pg then dials localhost)', 'postgres:///fakedb', { option: 'off', tls: 'off', dest: 'localhost' });
  await expectCase('loopback + sslmode=require in the URL: the URL still wins, TLS is verified', 'postgres://fakeuser:fakepass@localhost:5432/fakedb?sslmode=require', { option: 'off', tls: 'verified' });
  await expectCase('loopback + sslmode=disable: plaintext', 'postgres://fakeuser:fakepass@127.0.0.1:5432/fakedb?sslmode=disable', { option: 'off', tls: 'off' });

  /* 4. text that merely CONTAINS "localhost" / "127.0.0.1" is not a loopback destination (the old substring test switched TLS off for all of these) */
  await expectCase('not loopback: host localhost.example.invalid', 'postgres://fakeuser:fakepass@localhost.example.invalid:5432/fakedb', V);
  await expectCase('not loopback: host mylocalhost.example.invalid', 'postgres://fakeuser:fakepass@mylocalhost.example.invalid:5432/fakedb', V);
  await expectCase('not loopback: host 127.0.0.1.example.invalid', 'postgres://fakeuser:fakepass@127.0.0.1.example.invalid:5432/fakedb', V);
  await expectCase('not loopback: PASSWORD containing "localhost"', `postgres://${USER}:localhost@${HOST}:5432/fakedb`, V);
  await expectCase('not loopback: password containing "127.0.0.1"', `postgres://${USER}:127.0.0.1@${HOST}:5432/fakedb`, V);
  await expectCase('not loopback: USER named localhost', `postgres://localhost:${SECRET}@${HOST}:5432/fakedb`, V);
  await expectCase('not loopback: DATABASE named localhost', `postgres://${USER}:${SECRET}@${HOST}:5432/localhost`, V);
  await expectCase('not loopback: a query value containing localhost', `${BASE}?application_name=localhost`, V);
  await expectCase('not loopback: 127.0.0.2 (only the exact loopback names that were supported before are exempt)', 'postgres://fakeuser:fakepass@127.0.0.2:5432/fakedb', V);
  await expectCase('not loopback: "localhost." with a trailing dot (conservative: verified TLS)', 'postgres://fakeuser:fakepass@localhost.:5432/fakedb', V);

  /* 5. the ACTUAL destination decides — not the host written in front of it */
  await expectCase('?host= override: URL says localhost but pg dials the remote host → verified TLS', `postgres://${USER}:${SECRET}@localhost:5432/fakedb?host=${HOST}`, { ...V, dest: HOST });
  await expectCase('empty URL host + PGHOST pointing at a remote host → verified TLS', 'postgres:///fakedb', { ...V, dest: HOST }, { PGHOST: HOST });
  await expectCase('unparseable URL: db.js does not throw and does not treat it as loopback → verified TLS option (the real pool reports the parse error at its first query, as before)', 'postgres://[::1', { option: 'verified', tls: 'unresolvable' });

  /* 6. everything else db.js hands to the pool is unchanged */
  ok('settings preserved: exactly {connectionString, ssl, max}, max 5, the URL passed through untouched', first && JSON.stringify(Object.keys(first.opts).sort()) === '["connectionString","max","ssl"]' && first.opts.max === 5 && first.opts.connectionString === BASE, JSON.stringify(first && Object.keys(first.opts)));
  ok('the pool error listener is still registered (exactly one) on a pool built from a URL', first && first.pool.listenerCount('error') === 1, String(first?.pool.listenerCount('error')));
  ok('nothing was logged that contains the synthetic user, password or host', captured.filter((l) => [SECRET, HOST, USER].some((s) => l.includes(s))).length === 0, JSON.stringify(captured.filter((l) => [SECRET, HOST, USER].some((s) => l.includes(s))).map((l) => l.slice(0, 80))));
  ok('the pg deprecation warning (emitted by pg itself for sslmode=require) names no host or credential', warnings.every((m) => ![SECRET, HOST, USER].some((s) => m.includes(s))), JSON.stringify(warnings.map((m) => m.slice(0, 60))));

  /* 7. an injected pool is used as given: no pool is built, no TLS decision is made, the existing guard still applies */
  const { Pool: MemPool } = newDb().adapters.createPg();
  const inner = new MemPool();
  const injected = Object.assign(new EventEmitter(), { query: (...a) => inner.query(...a), end: () => inner.end() });
  const keysBefore = Object.keys(injected).sort().join(), poolsBefore = recorded.length;
  process.env.DATABASE_URL = BASE;
  let storeInj; try { storeInj = await quiet(() => createStore({ pool: injected })); } finally { delete process.env.DATABASE_URL; }
  ok('injected pool: used as given — no new pool built, no ssl/options added to it, the error guard attached once', storeInj.kind === 'postgres' && recorded.length === poolsBefore && Object.keys(injected).sort().join() === keysBefore && injected.listenerCount('error') === 1);
  ok('injected pool: the store still works through it', (await storeInj.userCount()) === 0);
  await storeInj.close();

  /* 8. the source no longer contains the substring test or the PGSSL override, and never turns verification off in code */
  const src = readFileSync(fileURLToPath(new URL('./db.js', import.meta.url)), 'utf8');
  ok('source: no PGSSL override, no "rejectUnauthorized: false" and no substring test on the URL remain in db.js', !/PGSSL/.test(src) && !/rejectUnauthorized:\s*false/.test(src) && !/\/localhost\|127/.test(src));
  ok('source: pgAdapter builds the pool with ssl from pgSslFor(pg, url) and keeps connectionString and max: 5', /new pg\.Pool\(\{ connectionString: poolOrUrl, ssl: pgSslFor\(pg, poolOrUrl\), max: 5 \}\)/.test(src));
  ok('source: the remote default is certificate verification (rejectUnauthorized: true)', /\{ rejectUnauthorized: true \}/.test(src));

  ok('no connection was ever attempted (connect() was booby-trapped and never called)', connects === 0, String(connects));
} finally {
  pg.Pool = RealPool;
  pg.Client.prototype.connect = realConnect;
}

console.log(`\n${pass} passed, ${fail} failed`);
setTimeout(() => process.exit(fail ? 1 : 0), 100);
