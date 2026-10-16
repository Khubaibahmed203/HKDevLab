// Simulates Vercel: several INDEPENDENT copies of the app (separate memory) sharing ONE database, plus the real
// api/index.js handler. Proves that lock-out, the first-account race, content edits and the missing-database
// failure mode all behave correctly when requests are spread across copies.
// Run: node server/test-serverless.mjs
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DB = join(tmpdir(), 'hk-serverless-test.db');
for (const s of ['', '-wal', '-shm']) rmSync(DB + s, { force: true });
Object.assign(process.env, { SQLITE_PATH: DB, SMTP_HOST: '', SETUP_TOKEN: '', GOOGLE_CLIENT_ID: '', NODE_ENV: 'development', CONTENT_TTL_MS: '150' });
delete process.env.DATABASE_URL;

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { (cond ? pass++ : fail++); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };
const { createApp } = await import(new URL('./app.js', import.meta.url).href);

// three "lambdas": each has its own memory (own limiter object, own content cache, own DB connection)
const copies = [];
for (const port of [8821, 8822, 8823]) {
  const ctx = await createApp();
  const server = await new Promise((r) => { const s = ctx.app.listen(port, () => r(s)); });
  copies.push({ ...ctx, server, base: `http://localhost:${port}` });
}
const [A, B, C] = copies;

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
const owner = new Client();

/* 1) first-account race across three separate servers */
const racers = [A, B, C].map((c, i) => new Client().req(c.base, 'POST', '/api/auth/setup', { name: `Racer ${i}`, email: `racer${i}@example.com`, password: `a-long-racer-password-${i}` }));
const outcomes = (await Promise.all(racers)).map((r) => r.status).sort();
ok('three simultaneous first-account attempts on THREE servers create exactly one admin', outcomes.join() === '201,403,403', outcomes.join());
ok('…and the database holds exactly one user', (await A.store.userCount()) === 1);
const winnerIdx = (await A.store.listUsers())[0].email.match(/racer(\d)/)[1];
const winner = { email: `racer${winnerIdx}@example.com`, password: `a-long-racer-password-${winnerIdx}` };

/* 2) login lock-out is shared: guesses spread over different copies still add up */
const target = { email: winner.email };
const codes = [];
for (let i = 0; i < 7; i++) {
  const c = copies[i % 3];
  codes.push((await new Client().req(c.base, 'POST', '/api/auth/login', { ...target, password: 'wrong-guess-number-' + i })).status);
}
ok('7 wrong guesses spread across 3 servers: first 5 → 401, then locked out (429) everywhere', codes.slice(0, 5).every((x) => x === 401) && codes.slice(5).every((x) => x === 429), codes.join());
let r = await new Client().req(C.base, 'POST', '/api/auth/login', { ...target, password: winner.password });
ok('while locked, even the CORRECT password is refused — on any server', r.status === 429);
await A.store.rateClear(`em:${(await import('node:crypto')).createHash('sha256').update('hkdevlab:' + winner.email).digest('hex').slice(0, 24)}`);
r = await owner.req(A.base, 'POST', '/api/auth/login', { email: winner.email, password: winner.password });
ok('once the account counter is cleared, the right password logs in', r.status === 200 && r.data.user.role === 'admin', JSON.stringify(r));

/* 3) sessions are shared: log in on one server, be recognised on the others */
r = await owner.req(B.base, 'GET', '/api/auth/me');
ok('a session created on server A is valid on server B', r.status === 200 && r.data.user.email === winner.email);
r = await owner.req(C.base, 'GET', '/api/admin/content');
ok('…and on server C', r.status === 200 && r.data.content.hero.chips.length === 4);

/* 4) content edits show up on other copies within seconds (TTL 150 ms in this test) */
const content = r.data.content;
const contentVersion = r.data.version;          // saves must carry the content version the document was loaded with
content.hero.eyebrow = 'Edited on server A';
r = await owner.req(A.base, 'PUT', '/api/admin/content', { content, version: contentVersion });
ok('content saved on server A', r.status === 200);
await new Promise((res) => setTimeout(res, 300));
r = await new Client().req(B.base, 'GET', '/api/content');
ok('the public API on server B serves it after the cache window', r.data.hero.eyebrow === 'Edited on server A', JSON.stringify(r.data.hero).slice(0, 80));
r = await owner.req(C.base, 'GET', '/api/admin/content');
ok('the admin editor on server C always reads fresh (never stale)', r.data.content.hero.eyebrow === 'Edited on server A');

/* 5) contact form: shared per-visitor rate limit + stored once + email attempted before the reply */
const visitor = new Client();
const sent = [];
for (let i = 0; i < 7; i++) sent.push((await visitor.req(copies[i % 3].base, 'POST', '/api/contact', { name: 'Vis Itor', email: 'v@example.com', type: 'Not sure yet', message: 'A long enough message ' + i, elapsed: 9000 })).status);
ok('the 5-per-15-minutes contact limit holds across servers (201×5 then 429)', sent.slice(0, 5).every((x) => x === 201) && sent.slice(5).every((x) => x === 429), sent.join());
r = await owner.req(A.base, 'GET', '/api/admin/enquiries');
ok('all 5 accepted messages are stored, each with email_sent recorded', r.data.items.length === 5 && r.data.items.every((e) => e.email_sent === true), JSON.stringify(r.data.counts));

/* 6) the real Vercel handler: works, and fails safely without a database */
const handler = (await import(new URL('../api/index.js', import.meta.url).href)).default;
const vercelLike = http.createServer((req, res) => handler(req, res));
await new Promise((res) => vercelLike.listen(8824, res));
r = await new Client().req('http://localhost:8824', 'GET', '/api/health');
ok('api/index.js handler serves /api/health', r.status === 200 && r.data.ok === true);
ok('…and it reports only the database adapter name ("sqlite"), never the database file path', r.data.db === 'sqlite' && Object.values(r.data).every((v) => !String(v).includes(DB) && !String(v).includes(tmpdir()) && !String(v).includes('hk-serverless-test')), JSON.stringify(r.data));
r = await new Client().req('http://localhost:8824', 'GET', '/admin');
ok('…and /admin (the portal page)', r.status === 200);
r = await new Client().req('http://localhost:8824', 'GET', '/admin/schema.js');
ok('…and the shared schema file', r.status === 200);
vercelLike.close();

process.env.SQLITE_PATH = join('Z:\\definitely\\not\\writable\\place', 'x.db');     // simulate "no usable database"
const broken = (await import(new URL('../api/index.js?broken', import.meta.url).href)).default;
const brokenSrv = http.createServer((req, res) => broken(req, res));
await new Promise((res) => brokenSrv.listen(8825, res));
const raw = await fetch('http://localhost:8825/api/health');
const body = await raw.text();
ok('with no usable database the handler answers 500 with a generic message', raw.status === 500 && /not configured correctly/.test(body), body.slice(0, 120));
ok('…and never leaks paths or connection details', !/Z:|definitely|postgres:|password/i.test(body));
brokenSrv.close();

for (const c of copies) { c.server.close(); await c.store.close(); }
console.log(`\n${pass} passed, ${fail} failed`);
// the handler test's copy still holds the file open (Windows), so remove the temp database only once the process exits
process.on('exit', () => { for (const s of ['', '-wal', '-shm']) { try { rmSync(DB + s, { force: true }); } catch { /* temp file, harmless */ } } });
setTimeout(() => process.exit(fail ? 1 : 0), 300);
