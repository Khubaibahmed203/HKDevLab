// TLS policy of the PostgreSQL connection that db.js builds from DATABASE_URL — proven WITHOUT any database or network:
//  • pg.Pool is replaced by a recording fake (pg-mem answers the queries), so the REAL createStore → pgAdapter path runs and the exact options it hands to `new pg.Pool` are read;
//  • the TLS that pg would then really use is resolved with `new pg.Client(thoseOptions).connectionParameters.ssl` — the same merge pg-pool performs when it opens a client —
//    and `.connect()` is booby-trapped, so a test that ever dialled would fail instead of connecting. All hosts and credentials are synthetic (`.invalid` is a reserved TLD).
// Phase 5 D5.1i — the policy is FAIL CLOSED: for a non-loopback host createStore() REFUSES (error code DB_TLS_NOT_VERIFIED, before any pool is built or any connection is attempted) every URL whose effective TLS
// (pg's own merge of URL + option) is plaintext, encrypted-but-unverified, hostname-unchecked or of an unrecognised shape, and refuses NODE_TLS_REJECT_UNAUTHORIZED=0 wherever the options do not say
// rejectUnauthorized themselves. Verified forms (Neon sslmode=require, verify-full, a custom CA through sslrootcert) and every loopback destination are accepted exactly as before.
// Run: node server/test-pg-tls-policy.mjs
import { EventEmitter } from 'node:events';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { newDb } from 'pg-mem';
import { createStore } from './db.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { (cond ? pass++ : fail++); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };
const watchdog = setTimeout(() => { console.log('FAIL  watchdog: the test did not finish in time'); process.exit(1); }, 120_000);
watchdog.unref();

// a developer's own PG* variables (and NODE_TLS_REJECT_UNAUTHORIZED, which the policy reads) must not leak into the resolution of the synthetic URLs
for (const k of Object.keys(process.env)) if (/^PG/i.test(k) || /^HKDEV_TEST_PG/i.test(k) || k === 'NODE_TLS_REJECT_UNAUTHORIZED') delete process.env[k];

const SECRET = 'fakepass', HOST = 'db.example.invalid', USER = 'fakeuser';
const BASE = `postgres://${USER}:${SECRET}@${HOST}:5432/fakedb`;

/* ── instruments ── */
let connects = 0;
let queryFailure = null;                       // when set, the recording pool's query() throws it: stands in for any ordinary database error (authentication, network, timeout)
const realConnect = pg.Client.prototype.connect;
pg.Client.prototype.connect = function () { connects++; throw new Error('connect() must never be called by this test'); };

const recorded = [], instances = [];
const RealPool = pg.Pool;
class RecordingPool extends EventEmitter {
  constructor(opts) { super(); recorded.push(opts); instances.push(this); const { Pool } = newDb().adapters.createPg(); this.inner = new Pool(); }
  query(...a) { if (queryFailure) throw queryFailure; return this.inner.query(...a); }
  end() { return this.inner.end(); }
  connect() { connects++; throw new Error('connect() must never be called by this test'); }
}
pg.Pool = RecordingPool;

// pg's URL parser can produce only a few ssl shapes today; the policy also has to refuse every OTHER shape it cannot prove safe (a future pg, a parser bug). To exercise those branches, a test-only Client subclass
// (never connected) can have its resolved connectionParameters.ssl forced to any value — assertVerifiedTls() reads exactly that, from a Client it constructs itself.
const NOFORCE = Symbol('no forced ssl');
let forcedSsl = NOFORCE;
const RealClient = pg.Client;
class HookedClient extends RealClient { constructor(c) { super(c); if (forcedSsl !== NOFORCE) this.connectionParameters.ssl = forcedSsl; } }
pg.Client = HookedClient;

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

// fixtures for sslrootcert / sslcert / sslkey: pg's URL parser only READS the file and hands its text on; nothing here is parsed as a certificate and nothing is dialled
const FX = join(tmpdir(), `hk-tls-policy-fixture-${process.pid}.pem`), FXQ = encodeURIComponent(FX);
const FXMISSING = encodeURIComponent(join(tmpdir(), `hk-tls-policy-missing-${process.pid}.pem`));
writeFileSync(FX, 'not-a-real-certificate: a test fixture that pg only reads\n');
const mk = (message, props) => Object.assign(new Error(message), props);

/** A configuration the policy must REFUSE: createStore() rejects with the stable code and a fixed reason BEFORE any pool is built or any connection is attempted, and nothing from the URL leaks. */
const expectRejected = async (label, url, reason, env, extraSecrets = []) => {
  const keys = ['DATABASE_URL', ...Object.keys(env || {})], saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, env || {}, { DATABASE_URL: url });
  const pools0 = recorded.length, cap0 = captured.length, connects0 = connects;
  let err = null;
  try { await quiet(() => createStore()); } catch (e) { err = e; } finally { for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
  const hay = err ? [err.message, String(err.stack), JSON.stringify({ ...err }), String(err)].join('\n') + '\n' + captured.slice(cap0).join('\n') : '';
  const leaked = [SECRET, HOST, USER, 'fakedb', 'postgres://', ...extraSecrets].filter((s) => hay.includes(s));
  ok(`${label}  →  REJECTED before any pool: DB_TLS_NOT_VERIFIED (${reason})`, !!err && err instanceof Error && err.code === 'DB_TLS_NOT_VERIFIED' && err.reason === reason && recorded.length === pools0 && connects === connects0 && leaked.length === 0 && JSON.stringify(Object.keys(err).sort()) === '["code","reason"]',
    err ? JSON.stringify({ code: err.code, reason: err.reason, poolsBuilt: recorded.length - pools0, connects: connects - connects0, leaked, keys: Object.keys(err) }) : 'createStore did not throw');
  return err;
};

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

  /* 1b. more verified forms that must keep working: a custom CA, client-certificate material, odd-but-safe values, the Neon shapes */
  await expectCase('remote, sslrootcert only (a custom CA, no sslmode)', `${BASE}?sslrootcert=${FXQ}`, V);
  await expectCase('remote, sslmode=require&sslrootcert (custom CA)', `${BASE}?sslmode=require&sslrootcert=${FXQ}`, V);
  await expectCase('remote, sslmode=verify-full&sslrootcert (custom CA)', `${BASE}?sslmode=verify-full&sslrootcert=${FXQ}`, V);
  await expectCase('remote, uselibpqcompat=true&sslmode=verify-full&sslrootcert (libpq semantics, host name still checked)', `${BASE}?uselibpqcompat=true&sslmode=verify-full&sslrootcert=${FXQ}`, V);
  await expectCase('remote, sslmode=require with client certificate material (sslcert + sslkey): verification is unchanged', `${BASE}?sslmode=require&sslcert=${FXQ}&sslkey=${FXQ}`, V);
  await expectCase('remote, ssl=1', `${BASE}?ssl=1`, V);
  await expectCase('remote, sslnegotiation=direct (implies TLS)', `${BASE}?sslnegotiation=direct`, V);
  await expectCase('remote, sslmode=allow (pg 8: verified TLS)', `${BASE}?sslmode=allow`, V);
  await expectCase('remote, an unknown sslmode value (pg 8: verified TLS)', `${BASE}?sslmode=bogus`, V);
  await expectCase('remote, sslmode=DISABLE in capitals is NOT "disable" (the value is case-sensitive): verified TLS', `${BASE}?sslmode=DISABLE`, V);
  await expectCase('remote, SSLMODE=disable in capitals is not an option pg reads: the adapter\'s verified option stands', `${BASE}?SSLMODE=disable`, V);
  await expectCase('remote, duplicate options where the LAST one is safe: sslmode=disable&sslmode=verify-full', `${BASE}?sslmode=disable&sslmode=verify-full`, V);
  await expectCase('remote, uselibpqcompat=false&sslmode=prefer', `${BASE}?uselibpqcompat=false&sslmode=prefer`, V);
  await expectCase('remote, sslmode=require&options=endpoint%3Dep-abc (the Neon pooler / SNI-less form)', `${BASE}?sslmode=require&options=endpoint%3Dep-abc`, V);
  await expectCase('a complete Neon-style URL (synthetic): sslmode=require&channel_binding=require', 'postgresql://neondb_owner:npg_fakepass@ep-cool-name-12345.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require', { ...V, dest: 'ep-cool-name-12345.us-east-2.aws.neon.tech' });
  await expectCase('a Neon-style POOLER URL (synthetic): -pooler host, sslmode=require', 'postgresql://neondb_owner:npg_fakepass@ep-cool-name-12345-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require', { ...V, dest: 'ep-cool-name-12345-pooler.us-east-2.aws.neon.tech' });

  /* 2. FAIL CLOSED (Phase 5 D5.1h/i): the 11 known insecure forms are refused before a pool exists — they used to be accepted as "the operator's choice" */
  const KNOWN11 = [
    ['sslmode=disable', 'plaintext'], ['ssl=0', 'plaintext'], ['ssl=', 'plaintext'], ['uselibpqcompat=true&sslmode=disable', 'plaintext'], ['sslmode=verify-full&sslmode=disable', 'plaintext'],
    ['sslmode=no-verify', 'certificate-not-verified'], ['ssl=no-verify', 'certificate-not-verified'], ['uselibpqcompat=true&sslmode=prefer', 'certificate-not-verified'], ['uselibpqcompat=true&sslmode=require', 'certificate-not-verified'],
    ['uselibpqcompat=true&sslmode=require&sslrootcert=@FX', 'hostname-not-checked'], ['uselibpqcompat=true&sslmode=verify-ca&sslrootcert=@FX', 'hostname-not-checked'],
  ];
  for (const [params, reason] of KNOWN11) await expectRejected(`INSECURE ?${params.replace('@FX', '<root.pem>')}`, `${BASE}?${params.replace('@FX', FXQ)}`, reason, null, [FX, FXQ]);
  ok('the 11 known insecure forms of D5.1h were all exercised (5 plaintext, 4 encrypted-but-unverified, 2 host-name-unchecked)', KNOWN11.length === 11 && KNOWN11.filter(([, r]) => r === 'plaintext').length === 5 && KNOWN11.filter(([, r]) => r === 'certificate-not-verified').length === 4 && KNOWN11.filter(([, r]) => r === 'hostname-not-checked').length === 2);
  await expectRejected('INSECURE ?ssl=false (pg keeps the STRING "false": a shape that cannot be proven to be verified TLS)', `${BASE}?ssl=false`, 'unrecognized-options');
  await expectRejected('INSECURE ?sslrootcert=<root.pem>&sslmode=disable (a root certificate does not rescue a later disable)', `${BASE}?sslrootcert=${FXQ}&sslmode=disable`, 'plaintext', null, [FX, FXQ]);
  await expectRejected('INSECURE ?sslmode=no-verify&sslrootcert=<root.pem> (a custom CA with the chain check switched off)', `${BASE}?sslmode=no-verify&sslrootcert=${FXQ}`, 'certificate-not-verified', null, [FX, FXQ]);
  await expectRejected('INSECURE: the URL host is loopback-looking text but pg dials the remote host (?host=) and the URL says sslmode=disable', `postgres://${USER}:${SECRET}@localhost:5432/fakedb?host=${HOST}&sslmode=disable`, 'plaintext');
  const unsafe = await expectRejected('INSECURE: sslmode=disable on a Neon-style host', 'postgresql://neondb_owner:npg_fakepass@ep-cool-name-12345.us-east-2.aws.neon.tech/neondb?sslmode=disable', 'plaintext', null, ['neondb_owner', 'npg_fakepass', 'neon.tech']);
  ok('the refusal names a fixed reason and the parameters to fix - never the host, user, password, database or any value from the URL', !!unsafe && /^PostgreSQL TLS is not verified \(plaintext\): /.test(unsafe.message) && /sslmode=require or verify-full/.test(unsafe.message) && /NODE_EXTRA_CA_CERTS/.test(unsafe.message) && !/neon|npg_|neondb/.test(unsafe.message), unsafe && unsafe.message.slice(0, 120));

  /* 3. loopback destinations: no TLS required, as before (and an explicit sslmode in the URL still wins) */
  await expectCase('loopback: localhost', 'postgres://fakeuser:fakepass@localhost:5432/fakedb', { option: 'off', tls: 'off', dest: 'localhost' });
  await expectCase('loopback: 127.0.0.1', 'postgres://fakeuser:fakepass@127.0.0.1:5432/fakedb', { option: 'off', tls: 'off', dest: '127.0.0.1' });
  await expectCase('loopback: IPv6 [::1] (pg reports the bracketed form)', 'postgres://fakeuser:fakepass@[::1]:5432/fakedb', { option: 'off', tls: 'off', dest: '[::1]' });
  await expectCase('loopback: IPv6 given as ?host=::1', `${BASE}?host=::1`, { option: 'off', tls: 'off', dest: '::1' });
  await expectCase('loopback: upper-case LOCALHOST (host names are case-insensitive)', 'postgres://fakeuser:fakepass@LOCALHOST:5432/fakedb', { option: 'off', tls: 'off' });
  await expectCase('loopback: no host in the URL (pg then dials localhost)', 'postgres:///fakedb', { option: 'off', tls: 'off', dest: 'localhost' });
  await expectCase('loopback + sslmode=require in the URL: the URL still wins, TLS is verified', 'postgres://fakeuser:fakepass@localhost:5432/fakedb?sslmode=require', { option: 'off', tls: 'verified' });
  await expectCase('loopback + sslmode=disable: plaintext', 'postgres://fakeuser:fakepass@127.0.0.1:5432/fakedb?sslmode=disable', { option: 'off', tls: 'off' });
  // the local-development exception is unchanged: a loopback database is NOT subject to the policy, whatever the URL says (the policy is about non-local hosts only)
  await expectCase('loopback stays EXEMPT: 127.0.0.1 + sslmode=no-verify (accepted exactly as before)', 'postgres://fakeuser:fakepass@127.0.0.1:5432/fakedb?sslmode=no-verify', { option: 'off', tls: 'encrypted-NOT-verified' });
  await expectCase('loopback stays EXEMPT: localhost + uselibpqcompat=true&sslmode=require', 'postgres://fakeuser:fakepass@localhost:5432/fakedb?uselibpqcompat=true&sslmode=require', { option: 'off', tls: 'encrypted-NOT-verified' });
  await expectCase('loopback stays EXEMPT: [::1] + ssl=0', 'postgres://fakeuser:fakepass@[::1]:5432/fakedb?ssl=0', { option: 'off', tls: 'off' });
  await expectCase('loopback stays EXEMPT: LOCALHOST + ssl=no-verify', 'postgres://fakeuser:fakepass@LOCALHOST:5432/fakedb?ssl=no-verify', { option: 'off', tls: 'encrypted-NOT-verified' });
  await expectCase('loopback stays EXEMPT: ?host=127.0.0.1 on a remote-looking URL host (the host pg dials decides)', `${BASE}?host=127.0.0.1&sslmode=disable`, { option: 'off', tls: 'off', dest: '127.0.0.1' });

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

  /* 5b. NODE_TLS_REJECT_UNAUTHORIZED=0: Node uses it only where the options do not say rejectUnauthorized themselves (read from Node's own source in D5.1h) — so it is refused only where it would weaken verification */
  const ENV0 = { NODE_TLS_REJECT_UNAUTHORIZED: '0' };
  await expectCase('NODE_TLS_REJECT_UNAUTHORIZED=0 + a remote URL WITHOUT ssl options: ACCEPTED - the adapter\'s own { rejectUnauthorized: true } is explicit, so Node ignores the variable', BASE, V, ENV0);
  await expectRejected('NODE_TLS_REJECT_UNAUTHORIZED=0 + ?sslmode=require (the Neon form: pg replaces the explicit option with {})', `${BASE}?sslmode=require`, 'env-disables-verification', ENV0);
  await expectRejected('NODE_TLS_REJECT_UNAUTHORIZED=0 + ?sslmode=verify-full', `${BASE}?sslmode=verify-full`, 'env-disables-verification', ENV0);
  await expectRejected('NODE_TLS_REJECT_UNAUTHORIZED=0 + ?ssl=true (pg passes the bare boolean)', `${BASE}?ssl=true`, 'env-disables-verification', ENV0);
  await expectRejected('NODE_TLS_REJECT_UNAUTHORIZED=0 + ?sslrootcert=<root.pem> (an object with only a CA)', `${BASE}?sslrootcert=${FXQ}`, 'env-disables-verification', ENV0, [FX, FXQ]);
  await expectRejected('NODE_TLS_REJECT_UNAUTHORIZED=0 + sslmode=no-verify: the MORE SPECIFIC reason is reported', `${BASE}?sslmode=no-verify`, 'certificate-not-verified', ENV0);
  await expectRejected('NODE_TLS_REJECT_UNAUTHORIZED=0 + sslmode=disable: the more specific reason is reported', `${BASE}?sslmode=disable`, 'plaintext', ENV0);
  for (const v of ['1', 'false', '', 'true', ' 0', '00']) await expectCase(`NODE_TLS_REJECT_UNAUTHORIZED=${JSON.stringify(v)} is not exactly "0" (Node does not read it as off): ?sslmode=require is ACCEPTED`, `${BASE}?sslmode=require`, V, { NODE_TLS_REJECT_UNAUTHORIZED: v });
  await expectCase('NODE_TLS_REJECT_UNAUTHORIZED=0 + a LOOPBACK URL without options: exempt', 'postgres://fakeuser:fakepass@localhost:5432/fakedb', { option: 'off', tls: 'off' }, ENV0);
  await expectCase('NODE_TLS_REJECT_UNAUTHORIZED=0 + a LOOPBACK URL with sslmode=require: exempt (accepted as before)', 'postgres://fakeuser:fakepass@localhost:5432/fakedb?sslmode=require', { option: 'off', tls: 'verified' }, ENV0);
  ok('the variable was restored after every row (this process is back to its original state)', process.env.NODE_TLS_REJECT_UNAUTHORIZED === undefined && process.env.DATABASE_URL === undefined);

  /* 5c. what pg itself cannot resolve is pg's business: it throws the same way on every connection attempt, so nothing can be dialled — the policy neither accepts it as "verified" nor replaces pg's own error */
  await expectCase('unresolvable by pg: uselibpqcompat=true&sslmode=verify-ca WITHOUT a CA (pg refuses it itself) - not turned into DB_TLS_NOT_VERIFIED, the pool is built as before', `${BASE}?uselibpqcompat=true&sslmode=verify-ca`, { option: 'verified', tls: 'unresolvable' });
  await expectCase('unresolvable by pg: sslrootcert pointing at a missing file (pg\'s own ENOENT at connect) - same', `${BASE}?sslrootcert=${FXMISSING}`, { option: 'verified', tls: 'unresolvable' });

  /* 5d. ordinary database errors are untouched: the very same error object reaches the caller, the pool had been built, nothing is wrapped or renamed */
  for (const [label, failure] of [['an authentication failure (28P01)', mk('password authentication failed for user "x"', { code: '28P01' })], ['a refused connection (ECONNREFUSED)', mk('connect ECONNREFUSED', { code: 'ECONNREFUSED' })], ['a connection timeout', mk('Connection terminated due to connection timeout')], ['a statement timeout (57014)', mk('canceling statement due to statement timeout', { code: '57014' })]]) {
    const poolsBefore = recorded.length; queryFailure = failure; process.env.DATABASE_URL = `${BASE}?sslmode=require`;
    let thrown = null; try { await quiet(() => createStore()); } catch (e) { thrown = e; } finally { delete process.env.DATABASE_URL; queryFailure = null; }
    ok(`unrelated error stays untouched: ${label} reaches the caller as the very same error object (not wrapped, not DB_TLS_NOT_VERIFIED); the verified pool had been built`, thrown === failure && thrown.code !== 'DB_TLS_NOT_VERIFIED' && recorded.length === poolsBefore + 1, thrown && thrown.code);
    await instances[instances.length - 1].end();
  }

  /* 5e. what an operator sees: both entry points report a failed start as `e.code || e.message`, so it is DB_TLS_NOT_VERIFIED and never the URL */
  const apiSrc = readFileSync(fileURLToPath(new URL('../api/index.js', import.meta.url)), 'utf8'), indexSrc = readFileSync(fileURLToPath(new URL('./index.js', import.meta.url)), 'utf8');
  ok('startup reporting: api/index.js and server/index.js print only `e.code || e.message` (the stable code, never DATABASE_URL)', /console\.error\([^\n]*e\.code \|\| e\.message/.test(apiSrc) && /Could not start: \$\{e\.code \|\| e\.message\}/.test(indexSrc));

  /* 5f. shapes URL parsing cannot produce today, forced through pg's resolved parameters: anything that is not provably "TLS with certificate AND host-name verification" is refused, nothing slips through */
  const fmt = (v) => (typeof v === 'function' ? 'function' : Array.isArray(v) ? JSON.stringify(v) : v === undefined ? 'undefined' : typeof v === 'object' && v !== null ? '{' + Object.keys(v).join(',') + '}' : JSON.stringify(v));
  const forced = async (shape, fn) => { forcedSsl = shape; try { return await fn(); } finally { forcedSsl = NOFORCE; } };
  const expectAccepted = async (label, url, env) => {
    let got = null, err = null; try { got = await run(url, env); } catch (e) { err = e; }
    ok(label, !err && !!got && got.pools === 1, err ? `threw ${err.code || err.name}` : JSON.stringify({ pools: got && got.pools }));
  };
  const SHAPES_REJECTED = [
    [false, 'plaintext'], ['', 'plaintext'], [null, 'plaintext'], [undefined, 'plaintext'], [0, 'plaintext'],
    [1, 'unrecognized-options'], ['true', 'unrecognized-options'], ['no-verify', 'unrecognized-options'], [[], 'unrecognized-options'], [[true], 'unrecognized-options'], [() => {}, 'unrecognized-options'],
    [{ rejectUnauthorized: false }, 'certificate-not-verified'], [{ rejectUnauthorized: false, ca: 'x' }, 'certificate-not-verified'],
    [{ rejectUnauthorized: true, checkServerIdentity() {} }, 'hostname-not-checked'], [{ ca: 'x', checkServerIdentity() {} }, 'hostname-not-checked'],
    [{ checkServerIdentity: undefined }, 'unrecognized-options'], [{ servername: 'other.example.invalid' }, 'unrecognized-options'], [{ secureContext: {} }, 'unrecognized-options'], [{ minVersion: 'TLSv1' }, 'unrecognized-options'],
    [{ ciphers: 'NULL' }, 'unrecognized-options'], [{ ca: 'x', pskCallback() {} }, 'unrecognized-options'], [{ requestCert: false }, 'unrecognized-options'],
    [{ rejectUnauthorized: 'false' }, 'unrecognized-options'], [{ rejectUnauthorized: 0 }, 'unrecognized-options'], [{ rejectUnauthorized: null }, 'unrecognized-options'], [{ rejectUnauthorized: 1 }, 'unrecognized-options'],
  ];
  for (const [shape, reason] of SHAPES_REJECTED) await forced(shape, () => expectRejected(`FORCED effective ssl = ${fmt(shape)} on a remote host`, BASE, reason));
  for (const [label, shape] of [['true (Node\'s default verification)', true], ['{}', {}], ['{ ca }', { ca: 'x' }], ['{ ca, cert, key }', { ca: 'x', cert: 'y', key: 'z' }], ['{ rejectUnauthorized: true }', { rejectUnauthorized: true }], ['{ rejectUnauthorized: true, ca }', { rejectUnauthorized: true, ca: 'x' }]]) {
    await forced(shape, () => expectAccepted(`FORCED effective ssl = ${label} on a remote host: provably verified → ACCEPTED`, BASE));
  }
  for (const [label, shape, ok2] of [['true', true, false], ['{}', {}, false], ['{ ca }', { ca: 'x' }, false], ['{ ca, cert, key }', { ca: 'x', cert: 'y', key: 'z' }, false], ['{ rejectUnauthorized: true }', { rejectUnauthorized: true }, true], ['{ rejectUnauthorized: true, ca }', { rejectUnauthorized: true, ca: 'x' }, true]]) {
    await forced(shape, () => (ok2 ? expectAccepted(`FORCED effective ssl = ${label} + NODE_TLS_REJECT_UNAUTHORIZED=0: the explicit true survives the variable → ACCEPTED`, BASE, ENV0) : expectRejected(`FORCED effective ssl = ${label} + NODE_TLS_REJECT_UNAUTHORIZED=0: Node would fill the gap with "off"`, BASE, 'env-disables-verification', ENV0)));
  }
  for (const shape of [false, null, [], 'weird', { rejectUnauthorized: false }, { servername: 'x' }, { checkServerIdentity() {} }]) {
    await forced(shape, () => expectAccepted(`FORCED effective ssl = ${fmt(shape)} on a LOOPBACK host: exempt, not judged`, 'postgres://fakeuser:fakepass@localhost:5432/fakedb'));
  }
  ok('the forcing hook is switched off again (later cases see pg\'s real resolution)', forcedSsl === NOFORCE);

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
  // the policy governs pools db.js builds from a URL; an injected pool is the caller's own, even with an insecure DATABASE_URL in the environment
  const { Pool: MemPool2 } = newDb().adapters.createPg();
  const inner2 = new MemPool2();
  const injected2 = Object.assign(new EventEmitter(), { query: (...a) => inner2.query(...a), end: () => inner2.end() });
  process.env.DATABASE_URL = `${BASE}?sslmode=disable`;
  let storeInj2 = null, errInj2 = null; try { storeInj2 = await quiet(() => createStore({ pool: injected2 })); } catch (e) { errInj2 = e; } finally { delete process.env.DATABASE_URL; }
  ok('injected pool + an INSECURE DATABASE_URL in the environment: still used as given - no policy error, no pool built (SQLite and injected-pool behaviour are preserved)', !errInj2 && !!storeInj2 && storeInj2.kind === 'postgres' && recorded.length === poolsBefore, errInj2 && errInj2.code);
  if (storeInj2) await storeInj2.close();

  /* 8. the source no longer contains the substring test or the PGSSL override, and never turns verification off in code */
  const src = readFileSync(fileURLToPath(new URL('./db.js', import.meta.url)), 'utf8');
  ok('source: no PGSSL override, no "rejectUnauthorized: false" and no substring test on the URL remain in db.js', !/PGSSL/.test(src) && !/rejectUnauthorized:\s*false/.test(src) && !/\/localhost\|127/.test(src));
  ok('source: pgAdapter builds the pool with ssl from pgSslFor(pg, url) and keeps connectionString and max: 5', /new pg\.Pool\(\{ connectionString: poolOrUrl, ssl: pgSslFor\(pg, poolOrUrl\), max: 5 \}\)/.test(src));
  ok('source: the remote default is certificate verification (rejectUnauthorized: true)', /\{ rejectUnauthorized: true \}/.test(src));
  ok('source D5.1i: the policy runs INSIDE the URL branch of pgAdapter, immediately before the pool is built (assertVerifiedTls(pg, poolOrUrl), then new pg.Pool)', /if \(typeof poolOrUrl === 'string'\) \{\s*const \{ default: pg \} = await import\('pg'\);\s*assertVerifiedTls\(pg, poolOrUrl\);[^\n]*\n\s*pool = new pg\.Pool\(/.test(src));
  ok('source D5.1i: one stable error code, DB_TLS_NOT_VERIFIED, defined once', (src.match(/DB_TLS_NOT_VERIFIED/g) || []).length === 1);
  const envReads = [...new Set([...src.matchAll(/process\.env\.(\w+)/g)].map((m) => m[1]))].sort();
  ok('source D5.1i: NO insecure opt-out - db.js reads only SQLITE_PATH, DATABASE_URL and NODE_TLS_REJECT_UNAUTHORIZED from the environment', JSON.stringify(envReads) === JSON.stringify(['DATABASE_URL', 'NODE_TLS_REJECT_UNAUTHORIZED', 'SQLITE_PATH']), JSON.stringify(envReads));
  const throwLine = src.split('\n').find((l) => l.includes("code: 'DB_TLS_NOT_VERIFIED'")) || '';
  ok('source D5.1i: the error message interpolates only the fixed reason - nothing from the URL, the host or the credentials', (throwLine.match(/\$\{/g) || []).length === 1 && /\$\{reason\}/.test(throwLine) && !/connectionString|params\.|poolOrUrl/.test(throwLine));
  ok('source D5.1i: the decision is made on pg\'s own merged connectionParameters (host + ssl), never on URL text, with an allow-list of ssl keys', /\.connectionParameters/.test(src) && /TLS_SAFE_KEYS = new Set\(\['ca', 'cert', 'key', 'rejectUnauthorized'\]\)/.test(src) && !/connectionString\.(includes|match|indexOf|test|startsWith)|\.test\(connectionString\)/.test(src));
  ok('source D5.1i: the options handed to the pool are unchanged - exactly { connectionString, ssl: pgSslFor(...), max: 5 }, no rewritten URL', /new pg\.Pool\(\{ connectionString: poolOrUrl, ssl: pgSslFor\(pg, poolOrUrl\), max: 5 \}\)/.test(src));

  ok('no connection was ever attempted (connect() was booby-trapped and never called)', connects === 0, String(connects));
} finally {
  pg.Pool = RealPool;
  pg.Client = RealClient;
  pg.Client.prototype.connect = realConnect;
  rmSync(FX, { force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
setTimeout(() => process.exit(fail ? 1 : 0), 100);
