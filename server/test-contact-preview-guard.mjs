// The contact form on a Vercel Preview/Development deployment: refused FIRST (HTTP 503), before the body is parsed, the rate limiter is touched, anything is validated, stored or
// mailed — and Production, Render and local runs behave exactly as before. Everything is synthetic: the real createApp on a loopback port with a TEMPORARY SQLite file per app and the
// development mailer (SMTP_HOST empty, nothing leaves the machine). Spies on store.insert / store.rate* / mailer.sendEnquiry and direct SQL counts give the proof of "nothing happened".
// Run: node server/test-contact-preview-guard.mjs
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

let pass = 0, fail = 0;
const realLog = console.log;
const ok = (name, cond, extra = '') => { (cond ? pass++ : fail++); realLog(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };
const watchdog = setTimeout(() => { realLog('FAIL  watchdog: the test did not finish in time'); process.exit(1); }, 120_000);
watchdog.unref();

/* ── environment: everything this test changes is remembered and restored at the end ── */
const TOUCHED = ['SQLITE_PATH', 'SMTP_HOST', 'SETUP_TOKEN', 'GOOGLE_CLIENT_ID', 'CONTENT_TTL_MS', 'MAIL_TO', 'MAIL_FROM', 'IP_HASH_SALT', 'NODE_ENV', 'VERCEL_ENV', 'DATABASE_URL', 'ALLOWED_ORIGINS', 'PUBLIC_URL'];
const savedEnv = Object.fromEntries(TOUCHED.map((k) => [k, process.env[k]]));
const setEnv = (k, v) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
Object.assign(process.env, { SMTP_HOST: '', SETUP_TOKEN: '', GOOGLE_CLIENT_ID: '', CONTENT_TTL_MS: '150', MAIL_TO: 'studio@example.test', MAIL_FROM: 'Test <noreply@example.test>', IP_HASH_SALT: 'preview-guard-test' });
for (const k of ['DATABASE_URL', 'ALLOWED_ORIGINS', 'PUBLIC_URL']) delete process.env[k];

/* ── everything the app prints is captured (the proof that no submitted data is logged) ── */
const captured = [];
const realConsole = Object.fromEntries(['log', 'error', 'warn', 'info', 'debug'].map((k) => [k, console[k]]));
for (const k of Object.keys(realConsole)) console[k] = (...a) => captured.push(a.map(String).join(' '));
const mailLines = (lines) => lines.filter((l) => l.includes('[mail:dev] would send')).length;

const MARK = 'PVG-7f3a91';
const PAYLOAD = { name: `Zed Tester ${MARK}`, email: 'zed.tester@example.test', type: 'Not sure yet', message: `${MARK} a synthetic message that is comfortably longer than ten characters.`, elapsed: 9000 };
const SECRETS = [MARK, 'Zed Tester', 'zed.tester'];
const leakedFrom = (lines) => SECRETS.filter((s) => lines.some((l) => l.includes(s)));     // reports WHICH marker leaked, never the line itself

const { createApp } = await import(new URL('./app.js', import.meta.url).href);

/* ── tiny loopback HTTP client (node:http, so no fetch/Undici port rules) ── */
function request(port, method, path, { headers = {}, body, rawBody } = {}) {
  return new Promise((resolve, reject) => {
    const payload = rawBody ?? (body === undefined ? undefined : JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port, method, path, agent: false, headers: { Connection: 'close', ...(payload !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let json; try { json = JSON.parse(text); } catch { /* not JSON */ } resolve({ status: res.statusCode, headers: res.headers, text, json }); });
    });
    let answered = false;
    req.on('response', () => { answered = true; });
    req.on('error', (e) => { if (!answered) reject(e); });
    req.end(payload);
  });
}
const post = (port, body, headers) => request(port, 'POST', '/api/contact', { body, headers });

/* ── one real app per scenario: temp SQLite file, spies, torn down afterwards ── */
const tempFiles = [], servers = [];
const cleanDb = (f) => { for (const s of ['', '-wal', '-shm']) rmSync(f + s, { force: true }); };
const count = (file, table) => { const db = new DatabaseSync(file); try { return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n; } finally { db.close(); } };
let seq = 0;
async function withApp({ nodeEnv = 'development', vercelEnv } = {}, fn) {
  const file = join(tmpdir(), `hk-contact-guard-${process.pid}-${++seq}.db`);
  cleanDb(file); tempFiles.push(file);
  setEnv('SQLITE_PATH', file); setEnv('NODE_ENV', nodeEnv); setEnv('VERCEL_ENV', vercelEnv);
  const ctx = await createApp();
  const spies = { insert: 0, setEmailed: 0, rate: 0, sendEnquiry: 0 };
  const wrap = (obj, name, key) => { const orig = obj[name]; obj[name] = function (...a) { spies[key]++; return orig.apply(this, a); }; };
  wrap(ctx.store, 'insert', 'insert'); wrap(ctx.store, 'setEmailed', 'setEmailed'); wrap(ctx.mailer, 'sendEnquiry', 'sendEnquiry');
  for (const name of Object.keys(ctx.store).filter((k) => /^rate/.test(k))) wrap(ctx.store, name, 'rate');
  const server = http.createServer(ctx.app); servers.push(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try { return await fn({ port, file, spies, store: ctx.store, env: (v) => setEnv('VERCEL_ENV', v) }); }
  finally { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); await ctx.store.close(); cleanDb(file); }
}

const REFUSAL = { ok: false, error: 'Contact submissions are disabled on preview deployments. Nothing was saved or sent.' };
const refused = (r) => r.status === 503 && r.headers['cache-control'] === 'no-store' && /application\/json/.test(String(r.headers['content-type'])) && JSON.stringify(r.json) === JSON.stringify(REFUSAL);
const untouched = (s) => s.insert === 0 && s.setEmailed === 0 && s.rate === 0 && s.sendEnquiry === 0;

try {
  /* 1. PRODUCTION (VERCEL_ENV=production, NODE_ENV=production): the existing contact route, unchanged */
  await withApp({ nodeEnv: 'production', vercelEnv: 'production' }, async ({ port, file, spies, store }) => {
    const mark = captured.length;
    let r = await post(port, PAYLOAD);
    ok('production: a valid submission returns 201 with an id', r.status === 201 && r.json?.ok === true && Number.isInteger(r.json?.id), JSON.stringify([r.status, r.json]));
    const rows = await store.list({ limit: 10 });
    ok('production: it is stored once, with the submitted fields, and email_sent is recorded', count(file, 'enquiries') === 1 && rows.length === 1 && rows[0].name === PAYLOAD.name && rows[0].email === PAYLOAD.email && rows[0].service === PAYLOAD.type && rows[0].message === PAYLOAD.message && rows[0].email_sent === true, JSON.stringify(rows.map((x) => ({ n: x.name, e: x.email_sent }))));
    ok('production: the studio notification AND the visitor auto-reply are attempted (one sendEnquiry, two mail lines), one insert', spies.insert === 1 && spies.sendEnquiry === 1 && mailLines(captured.slice(mark)) === 2, JSON.stringify(spies) + ' mailLines=' + mailLines(captured.slice(mark)));
    r = await post(port, {});
    ok('production: an empty submission is still a 400 with field errors (validation unchanged)', r.status === 400 && r.json?.ok === false && r.json?.errors?.name && r.json?.errors?.email && r.json?.errors?.message, JSON.stringify([r.status, r.json]));
    r = await post(port, { ...PAYLOAD, website: 'http://spam.example' });
    ok('production: a filled honeypot is still a fake 201 (no id) and stores nothing', r.status === 201 && r.json?.ok === true && r.json?.id === undefined && count(file, 'enquiries') === 1);
    r = await post(port, { ...PAYLOAD, elapsed: 500 });
    ok('production: a too-fast submission is still a fake 201 (no id) and stores nothing', r.status === 201 && r.json?.id === undefined && count(file, 'enquiries') === 1);
    r = await post(port, PAYLOAD, { Origin: 'https://evil.example' });
    ok('production: a foreign Origin is still a 403', r.status === 403 && r.json?.error === 'Forbidden.', JSON.stringify([r.status, r.json]));
    r = await request(port, 'POST', '/api/contact', { rawBody: '{"name":"Zed","email":' });
    ok('production: malformed JSON is still a 400 (the body parser is reached)', r.status === 400 && r.json?.ok === false, JSON.stringify([r.status, r.json]));
    r = await post(port, { ...PAYLOAD, message: 'x'.repeat(25_000) });
    ok('production: an oversize body is still a 413 (the body parser is reached)', r.status === 413, String(r.status));
    // slots used so far: valid, {}, honeypot, too-fast = 4 (foreign-Origin and parser errors return before the limiter)
    r = await post(port, PAYLOAD);
    ok('production: the 5th request in the window is admitted…', r.status === 201 && count(file, 'enquiries') === 2, String(r.status));
    r = await post(port, PAYLOAD);
    ok('production: …and the 6th is the unchanged 429 rate limit', r.status === 429 && /Too many messages/.test(String(r.json?.error)), JSON.stringify([r.status, r.json]));
  });

  /* 2. no VERCEL_ENV at all (local run; Render/VPS with NODE_ENV=production) and an empty VERCEL_ENV: behaviour as before */
  await withApp({ nodeEnv: 'development', vercelEnv: undefined }, async ({ port, file, spies }) => {
    const mark = captured.length;
    const r = await post(port, PAYLOAD);
    ok('local, VERCEL_ENV absent: 201, stored, mailed (as before)', r.status === 201 && count(file, 'enquiries') === 1 && spies.sendEnquiry === 1 && mailLines(captured.slice(mark)) === 2, JSON.stringify([r.status, spies]));
  });
  await withApp({ nodeEnv: 'production', vercelEnv: undefined }, async ({ port, file, spies, env }) => {
    let r = await post(port, PAYLOAD);
    ok('Render-like, VERCEL_ENV absent with NODE_ENV=production: 201, stored, mailed (as before)', r.status === 201 && count(file, 'enquiries') === 1 && spies.sendEnquiry === 1, JSON.stringify([r.status, spies]));
    env('');
    r = await post(port, PAYLOAD);
    ok('an EMPTY VERCEL_ENV counts as absent: 201 and stored', r.status === 201 && count(file, 'enquiries') === 2, JSON.stringify([r.status]));
  });

  /* 3. PREVIEW (as Vercel runs it: VERCEL_ENV=preview, NODE_ENV=production) */
  await withApp({ nodeEnv: 'production', vercelEnv: 'preview' }, async ({ port, file, spies, env }) => {
    const baseRates = count(file, 'rate_events'), mark = captured.length;
    ok('preview: starting point is empty (0 enquiries, 0 rate events)', count(file, 'enquiries') === 0 && baseRates === 0);

    let r = await post(port, PAYLOAD);
    ok('preview: a valid submission is refused with exactly 503 + Cache-Control: no-store + the specified JSON', refused(r), JSON.stringify([r.status, r.headers['cache-control'], r.json]));
    r = await request(port, 'POST', '/api/contact', { rawBody: `{"name":"Zed Tester ${MARK}","email":` });
    ok('preview: malformed JSON is a 503, not the parser\'s 400 (the body is never parsed)', refused(r), JSON.stringify([r.status, r.json]));
    r = await post(port, { ...PAYLOAD, message: 'x'.repeat(25_000) });
    ok('preview: an oversize body is a 503, not the parser\'s 413 (the body is never read)', refused(r), String(r.status));
    r = await request(port, 'POST', '/api/contact', { headers: { 'Content-Type': 'text/plain' }, rawBody: `name=Zed&message=${MARK}` });
    ok('preview: a non-JSON body is a 503 as well', refused(r), String(r.status));
    r = await request(port, 'POST', '/api/contact', {});
    ok('preview: an empty request is a 503 as well', refused(r), String(r.status));

    const bypass = [
      ['same-host Origin', { Origin: `http://127.0.0.1:${port}` }],
      ['foreign Origin (a 403 without the guard)', { Origin: 'https://evil.example' }],
      ['X-Forwarded-Host', { 'X-Forwarded-Host': 'hkdevlab.com' }],
      ['X-Forwarded-For (another visitor identity)', { 'X-Forwarded-For': '203.0.113.7' }],
      ['X-Forwarded-Proto', { 'X-Forwarded-Proto': 'https' }],
      ['a header that claims production (x-vercel-env: production)', { 'x-vercel-env': 'production' }],
      ['a spoofed Host and deployment URL', { Host: 'hkdevlab.com', 'x-vercel-deployment-url': 'hkdevlab.com' }],
      ['Authorization + Cookie + X-Requested-With', { Authorization: 'Bearer x', Cookie: 'hk_session=x', 'X-Requested-With': 'hk-admin' }],
      ['a browser User-Agent', { 'User-Agent': 'Mozilla/5.0' }],
    ];
    for (const [label, headers] of bypass) { r = await post(port, PAYLOAD, headers); ok(`preview: cannot be bypassed by ${label}`, refused(r), JSON.stringify([r.status, r.json])); }
    const six = []; for (let i = 0; i < 6; i++) six.push((await post(port, PAYLOAD)).status);
    ok('preview: six more submissions are all 503 — never a 429', six.every((s) => s === 503), six.join());

    ok('preview: ZERO enquiries stored (SQL count)', count(file, 'enquiries') === 0);
    ok('preview: ZERO rate-limit writes (SQL count unchanged) and ZERO store.rate* calls', count(file, 'rate_events') === baseRates && spies.rate === 0, JSON.stringify([count(file, 'rate_events'), spies.rate]));
    ok('preview: store.insert, store.setEmailed and mailer.sendEnquiry were never called', untouched(spies), JSON.stringify(spies));
    ok('preview: ZERO mails (no dev-mail line), and nothing printed contains the submitted name, email or message', mailLines(captured.slice(mark)) === 0 && leakedFrom(captured.slice(mark)).length === 0, JSON.stringify([mailLines(captured.slice(mark)), leakedFrom(captured.slice(mark))]));

    // other endpoints are not affected by the guard (checked after the zero-write assertions, since a login attempt records its own rate keys)
    r = await request(port, 'GET', '/api/health');
    ok('preview: GET /api/health is unaffected (200, ok)', r.status === 200 && r.json?.ok === true, String(r.status));
    r = await request(port, 'GET', '/api/content');
    ok('preview: GET /api/content is unaffected (200)', r.status === 200 && typeof r.json === 'object' && r.json !== null, String(r.status));
    r = await request(port, 'GET', '/api/contact');
    ok('preview: GET /api/contact is unchanged (404 — only the POST route is guarded)', r.status === 404, String(r.status));
    r = await request(port, 'POST', '/api/auth/login', { body: { email: 'nobody@example.test', password: 'wrong-password' }, headers: { 'X-Requested-With': 'hk-admin' } });
    ok('preview: another POST route (login) is unaffected — a normal 4xx, not the contact refusal', r.status >= 400 && r.status < 500 && JSON.stringify(r.json) !== JSON.stringify(REFUSAL), JSON.stringify([r.status, r.json]));

    // the same running app, the variable flipped (it is read on every request): Production behaviour returns, and the 12+ refused attempts used NO rate-limit slot
    env('production');
    const prod = []; for (let i = 0; i < 6; i++) prod.push((await post(port, PAYLOAD)).status);       // same visitor identity as the refused attempts above (no X-Forwarded-For)
    ok('the guard follows VERCEL_ENV on every request: with production set, 5 submissions pass (201) and the 6th is the normal 429 — so the refused preview attempts consumed no slot', prod.slice(0, 5).every((s) => s === 201) && prod[5] === 429 && count(file, 'enquiries') === 5, prod.join());
  });

  /* 4. DEVELOPMENT and other Vercel values */
  await withApp({ nodeEnv: 'development', vercelEnv: 'development' }, async ({ port, file, spies }) => {
    const mark = captured.length, r = await post(port, PAYLOAD);
    ok('development: refused with the same 503, nothing stored, nothing called, nothing mailed or logged', refused(r) && count(file, 'enquiries') === 0 && count(file, 'rate_events') === 0 && untouched(spies) && mailLines(captured.slice(mark)) === 0 && leakedFrom(captured.slice(mark)).length === 0, JSON.stringify([r.status, spies]));
  });
  await withApp({ nodeEnv: 'production', vercelEnv: 'staging' }, async ({ port, file, spies }) => {
    const r = await post(port, PAYLOAD);
    ok('an unknown VERCEL_ENV value ("staging") fails closed: 503, nothing stored or called', refused(r) && count(file, 'enquiries') === 0 && untouched(spies), JSON.stringify([r.status, spies]));
  });

  /* 5. NODE_ENV cannot be used to get past the guard */
  for (const nodeEnv of ['production', 'development', 'test', undefined]) {
    await withApp({ nodeEnv, vercelEnv: 'preview' }, async ({ port, file, spies }) => {
      const r = await post(port, PAYLOAD);
      ok(`preview with NODE_ENV=${nodeEnv === undefined ? '(absent)' : nodeEnv}: still refused, nothing stored or called`, refused(r) && count(file, 'enquiries') === 0 && untouched(spies), JSON.stringify([r.status, spies]));
    });
  }

  /* 6. the source: one guard, in front of the body parser, on the contact POST only, with no logging and no use of the request */
  const src = readFileSync(fileURLToPath(new URL('./app.js', import.meta.url)), 'utf8');
  const guardSrc = (src.match(/const contactDisabledOnPreview = [\s\S]*?\n  \};/) || [''])[0];
  ok('source: the contact POST registers the guard BEFORE express.json', /app\.post\('\/api\/contact', contactDisabledOnPreview, express\.json\(/.test(src));
  ok('source: the guard is used by that one route only, and VERCEL_ENV is read in exactly one place', (src.match(/contactDisabledOnPreview/g) || []).length === 2 && (src.match(/process\.env\.VERCEL_ENV/g) || []).length === 1);
  ok('source: the guard logs nothing, never touches the request body/headers, and does nothing asynchronous', guardSrc.length > 0 && !/console\.|req\.body|req\.get\(|req\.headers|await |setTimeout/.test(guardSrc), guardSrc.slice(0, 120));
} finally {
  /* 7. housekeeping: the environment, the temporary files and the servers are put back */
  Object.assign(console, realConsole);
  for (const k of TOUCHED) setEnv(k, savedEnv[k]);
}
ok('cleanup: every modified environment variable is back to its original value', TOUCHED.every((k) => process.env[k] === savedEnv[k]), TOUCHED.filter((k) => process.env[k] !== savedEnv[k]).join());
ok('cleanup: no temporary database file is left behind, and every test server is closed', tempFiles.every((f) => ['', '-wal', '-shm'].every((s) => !existsSync(f + s))) && servers.every((s) => !s.listening));

realLog(`\n${pass} passed, ${fail} failed`);
setTimeout(() => process.exit(fail ? 1 : 0), 100);
