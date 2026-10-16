// A PostgreSQL pool emits 'error' when an IDLE client's connection fails (a database restart, a dropped network). With no listener that event is thrown and, on a
// long-running host (the Node/Render server), ends the process. db.js registers ONE sanitized listener on every pool it uses; this proves it without any database or
// network: an EventEmitter-wrapped pg-mem pool, and a REAL pg.Pool that is constructed but never asked to connect.
// Run: node server/test-pg-pool-errors.mjs
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { newDb } from 'pg-mem';
import { createStore, guardPoolErrors } from './db.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { (cond ? pass++ : fail++); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };

const SECRET = 'S3cr3t-Pa55w0rd', HOST = 'db.example.test', USER = 'dbuser';
const CONN = `postgres://${USER}:${SECRET}@${HOST}:5432/prod`;
/** The kind of error pg-pool hands over for an idle client: a short code, a message that names the user and host, and extra properties holding the connection string. */
const leakyError = (code = 'ECONNRESET') => Object.assign(new Error(`password authentication failed for user "${USER}" on ${HOST} (${CONN})`), { code, detail: CONN, hint: SECRET, host: HOST });

// everything db.js logs while a step runs
const logged = [];
const realError = console.error;
console.error = (...args) => { logged.push(args.map(String).join(' ')); };
const logsDuring = (fn) => { logged.length = 0; fn(); return [...logged]; };
const leaks = (lines) => lines.filter((l) => [SECRET, HOST, USER, 'password authentication', 'postgres://'].some((s) => l.includes(s)));
const emitsWithoutThrowing = (pool, err) => { try { pool.emit('error', err); return true; } catch { return false; } };

try {
  /* 1. the hazard, on the REAL pg.Pool class: without a listener the event is thrown */
  const bare = new pg.Pool({ connectionString: CONN });                       // constructed only: pg connects on the first query, which never happens here
  ok('control: an unguarded pg.Pool throws when it emits "error" (this is what would end the process)', !emitsWithoutThrowing(bare, leakyError()));
  await bare.end();

  /* 2. guardPoolErrors on a real pg.Pool */
  const real = new pg.Pool({ connectionString: CONN });
  ok('guardPoolErrors returns the same pool', guardPoolErrors(real) === real);
  ok('…and registers exactly one "error" listener', real.listenerCount('error') === 1);
  let lines, survived;
  lines = logsDuring(() => { survived = emitsWithoutThrowing(real, leakyError()); });
  ok('a pool error no longer escapes as an unhandled event', survived);
  ok('…it is logged once, with only the short error code', lines.length === 1 && lines[0].includes('ECONNRESET') && /^\[db\] /.test(lines[0]), JSON.stringify(lines));
  ok('…and the log line exposes nothing from the error: no secret, host, user, message or connection string', leaks(lines).length === 0, JSON.stringify(leaks(lines)));
  guardPoolErrors(real); guardPoolErrors(real);
  ok('initialising the same pool again adds no further listener', real.listenerCount('error') === 1);
  await real.end();

  /* 3. whatever arrives is survived and sanitised */
  const probe = guardPoolErrors(new pg.Pool({ connectionString: CONN }));
  for (const [label, value, want] of [
    ['an error whose code is not a short identifier (it holds the secret)', leakyError(`x ${SECRET} ${CONN}`), 'unknown'],
    ['an error without a code', (() => { const e = leakyError(); delete e.code; return e; })(), 'unknown'],
    ['a SQLSTATE-style code', leakyError('57P01'), '57P01'],
    ['a string that is not an Error at all', `${CONN}`, 'unknown'],
    ['null', null, 'unknown'], ['undefined', undefined, 'unknown'], ['a number', 42, 'unknown'],
  ]) {
    let survivedThis; const got = logsDuring(() => { survivedThis = emitsWithoutThrowing(probe, value); });
    ok(`${label}: survived, logged once as (${want}), nothing leaked`, survivedThis && got.length === 1 && got[0].includes(`(${want})`) && leaks(got).length === 0, JSON.stringify(got));
  }
  await probe.end();

  /* 4. through createStore with an injected EventEmitter-style pool (pg-mem behind it) */
  const { Pool } = newDb().adapters.createPg();
  const inner = new Pool();
  const injected = Object.assign(new EventEmitter(), { query: (...a) => inner.query(...a), end: () => inner.end() });
  const store = await createStore({ pool: injected });
  ok('createStore registers the listener on an injected pool', store.kind === 'postgres' && injected.listenerCount('error') === 1);
  // (a second createStore on the SAME pg-mem database is not possible: pg-mem rejects "CREATE TABLE IF NOT EXISTS" for a table that exists — so initialising again is exercised on the helper)
  guardPoolErrors(injected);
  ok('…and initialising that pool again afterwards adds no further listener', injected.listenerCount('error') === 1);
  let survivedInjected; lines = logsDuring(() => { survivedInjected = emitsWithoutThrowing(injected, leakyError()); });
  ok('an error on the injected pool is survived, logged once, and leaks nothing', survivedInjected && lines.length === 1 && leaks(lines).length === 0, JSON.stringify(lines));
  const usersAfter = await store.userCount();
  ok('the store keeps working afterwards (the pool error changed nothing else)', usersAfter === 0, String(usersAfter));
  await store.close();

  /* 5. pools that cannot take a listener are left alone */
  let threw = false; try { guardPoolErrors(null); guardPoolErrors(undefined); guardPoolErrors({}); guardPoolErrors({ query() {}, end() {} }); } catch { threw = true; }
  ok('guardPoolErrors ignores null and pools without .on() instead of throwing', !threw);

  /* 6. the URL-created pool cannot be built without a database, so pin the call site: pgAdapter guards the pool it just built AND any injected one */
  const src = readFileSync(fileURLToPath(new URL('./db.js', import.meta.url)), 'utf8');
  ok('source: pgAdapter calls guardPoolErrors(pool) right after the URL-pool block, so it covers the pool it creates and an injected one',
    /async function pgAdapter\(poolOrUrl\) \{\r?\n  let pool = poolOrUrl;\r?\n  if \(typeof poolOrUrl === 'string'\) \{[\s\S]*?new pg\.Pool\([^\n]*\n  \}\r?\n  guardPoolErrors\(pool\);/.test(src));
  ok('source: no global process error handler was added to db.js', !/process\.(on|once)\(\s*['"](uncaughtException|unhandledRejection)/.test(src));
} finally {
  console.error = realError;
}

console.log(`\n${pass} passed, ${fail} failed`);
setTimeout(() => process.exit(fail ? 1 : 0), 100);
