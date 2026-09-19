// Exercises the PostgreSQL code path against an in-memory Postgres emulator (pg-mem).
// Run: node server/test-pg.mjs
import { newDb } from 'pg-mem';
import { createStore } from './db.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { (cond ? pass++ : fail++); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };

const { Pool } = newDb().adapters.createPg();
const pool = new Pool();
const store = await createStore({ pool });
ok('reports the postgres backend', store.kind === 'postgres');
await store.ping();

// enquiries
const id = await store.insert({ name: 'A B', email: 'a@b.co', service: 'X', message: 'hello there world', ipHash: 'h', userAgent: 'ua' });
ok('insert returns a numeric id', typeof id === 'number' && id > 0);
let rows = await store.list();
ok('list returns the row with a boolean email_sent', rows.length === 1 && rows[0].email_sent === false && typeof rows[0].id === 'number');
await store.setEmailed(id, true);
ok('setEmailed', (await store.list())[0].email_sent === true);
ok('setStatus', (await store.setStatus(id, 'read')) === true && (await store.counts()).read === 1);
ok('filtered list', (await store.list({ status: 'read' })).length === 1 && (await store.list({ status: 'new' })).length === 0);

// users
ok('no users yet', (await store.userCount()) === 0);
const uid = await store.createUser({ email: 'o@x.co', name: 'Owner', passwordHash: 'hash', role: 'admin' });
ok('createUser + counts', (await store.userCount()) === 1 && (await store.adminCount()) === 1);
ok('userByEmail includes hash, userById does not', (await store.userByEmail('o@x.co')).password_hash === 'hash' && !('password_hash' in (await store.userById(uid))));
await store.updateUser(uid, { name: 'Renamed', role: 'editor' });
ok('updateUser', (await store.userById(uid)).name === 'Renamed' && (await store.adminCount()) === 0);
await store.touchLogin(uid);
ok('touchLogin', !!(await store.userById(uid)).last_login_at);
let dup = false; try { await store.createUser({ email: 'o@x.co', name: 'Dup', passwordHash: 'h', role: 'editor' }); } catch { dup = true; }
ok('unique email enforced', dup);

// google linking + one-time oauth state
ok('new user starts unlinked, invited (no password)', (await store.userById(uid)).googleLinked === false && (await store.userById(uid)).hasPassword === false);
await store.linkGoogle(uid, 'sub-123');
ok('linkGoogle + userByGoogleSub', (await store.userByGoogleSub('sub-123')).email === 'o@x.co' && (await store.userById(uid)).googleLinked === true);
ok('unknown sub → null', (await store.userByGoogleSub('nope')) === null);
const inFuture = new Date(Date.now() + 60000).toISOString(), inPast = new Date(Date.now() - 1000).toISOString();
await store.createOAuthState({ hash: 'h1', verifier: 'v', nonce: 'n', setupOk: true, expiresAt: inFuture });
const taken = await store.takeOAuthState('h1');
ok('oauth state can be taken once', taken && taken.verifier === 'v' && taken.nonce === 'n' && taken.setupOk === true);
ok('…and never again (replay)', (await store.takeOAuthState('h1')) === null);
await store.createOAuthState({ hash: 'h2', verifier: 'v', nonce: 'n', setupOk: false, expiresAt: inPast });
ok('expired oauth state is refused', (await store.takeOAuthState('h2')) === null);

// sessions
const future = new Date(Date.now() + 864e5).toISOString(), past = new Date(Date.now() - 1000).toISOString();
await store.createSession(uid, 'tok1', future, 'ua');
ok('valid session resolves to the user', (await store.sessionUser('tok1'))?.email === 'o@x.co');
await store.createSession(uid, 'tok2', past, 'ua');
ok('expired session does not resolve', (await store.sessionUser('tok2')) === null);
await store.createSession(uid, 'tok3', future, 'ua');
await store.deleteUserSessions(uid, 'tok1');
ok('deleteUserSessions keeps the excepted one', (await store.sessionUser('tok1')) && !(await store.sessionUser('tok3')));
await store.deleteSession('tok1');
ok('deleteSession', (await store.sessionUser('tok1')) === null);

// content + versions
ok('no content yet', (await store.getContent()) === null);
await store.saveContent({ a: 1 }, 'o@x.co', 'first');
await store.saveContent({ a: 2 }, 'o@x.co', 'second');
ok('saveContent updates in place', (await store.getContent()).data.a === 2);
const vs = await store.listVersions();
ok('versions listed newest first', vs.length === 2 && vs[0].note === 'second' && typeof vs[0].id === 'number');
ok('getVersion', (await store.getVersion(vs[1].id)).a === 1);
for (let i = 0; i < 45; i++) await store.saveContent({ a: 100 + i }, 'o@x.co', `n${i}`);
ok('version history is capped at 40', (await store.listVersions()).length === 40);

// cleanup
ok('deleteUser', (await store.deleteUser(uid)) === true && (await store.userCount()) === 0);
ok('remove enquiry', (await store.remove(id)) === true && (await store.list()).length === 0);
await store.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
