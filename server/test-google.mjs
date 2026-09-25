// End-to-end test of "Continue with Google" against a FAKE Google (authorize + token endpoints).
// It starts the real server three times (normal / with SETUP_TOKEN / Google not configured) and drives every path.
// Run: node server/test-google.mjs      (needs ports 8811-8814; uses throw-away databases)
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FAKE_PORT = 8811, CLIENT_ID = 'test-client-id.apps.example', CLIENT_SECRET = 'test-secret';
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { (cond ? pass++ : fail++); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };
const b64u = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');

/* ───────── fake Google ───────── */
const pending = new Map();                       // code → what the "user" chose on the consent screen
const fake = http.createServer((req, res) => {
  const u = new URL(req.url, `http://localhost:${FAKE_PORT}`);
  if (u.pathname === '/authorize') {
    const q = u.searchParams;
    if (q.get('client_id') !== CLIENT_ID || q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge') || !q.get('state') || !q.get('nonce') || q.get('response_type') !== 'code') {
      res.writeHead(400); return res.end('bad authorize request');
    }
    const code = randomBytes(12).toString('hex');
    pending.set(code, {
      email: q.get('as'), sub: q.get('sub'), name: q.get('name') || '', verified: q.get('verified') !== 'false',
      nonce: q.get('badNonce') ? 'WRONG' : q.get('nonce'), challenge: q.get('code_challenge'), redirect: q.get('redirect_uri'), failToken: q.get('failToken') === '1',
    });
    res.writeHead(302, { Location: `${q.get('redirect_uri')}?code=${code}&state=${encodeURIComponent(q.get('state'))}` });
    return res.end();
  }
  if (u.pathname === '/token' && req.method === 'POST') {
    let body = ''; req.on('data', (d) => (body += d)); req.on('end', () => {
      const f = new URLSearchParams(body), e = pending.get(f.get('code'));
      pending.delete(f.get('code'));
      const bad = (msg) => { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: msg })); };
      if (!e || e.failToken) return bad('invalid_grant');
      if (f.get('client_secret') !== CLIENT_SECRET || f.get('client_id') !== CLIENT_ID || f.get('redirect_uri') !== e.redirect) return bad('invalid_client');
      if (createHash('sha256').update(f.get('code_verifier') || '').digest('base64url') !== e.challenge) return bad('pkce_failed');
      const claims = { iss: `http://localhost:${FAKE_PORT}`, aud: CLIENT_ID, exp: Math.floor(Date.now() / 1000) + 300, iat: Math.floor(Date.now() / 1000), nonce: e.nonce, sub: e.sub, email: e.email, email_verified: e.verified, name: e.name };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ access_token: 'x', token_type: 'Bearer', id_token: `${b64u({ alg: 'RS256' })}.${b64u(claims)}.sig` }));
    });
    return;
  }
  res.writeHead(404); res.end();
});
await new Promise((r) => fake.listen(FAKE_PORT, r));

/* ───────── helpers ───────── */
async function startServer(port, extraEnv) {
  const db = join(tmpdir(), `hk-google-test-${port}.db`);
  for (const suffix of ['', '-wal', '-shm']) rmSync(db + suffix, { force: true });
  const env = { ...process.env, SMTP_HOST: '', SETUP_TOKEN: '', GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', SQLITE_PATH: db, NODE_ENV: 'development', PUBLIC_URL: `http://localhost:${port}`, ...extraEnv };
  const child = spawn(process.execPath, ['server/index.js', `--port=${port}`], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => (log += d)); child.stderr.on('data', (d) => (log += d));
  for (let i = 0; i < 60 && !log.includes('admin:'); i++) await new Promise((r) => setTimeout(r, 150));
  return { child, base: `http://localhost:${port}`, db, log: () => log, stop: () => { child.kill(); setTimeout(() => ['', '-wal', '-shm'].forEach((s) => rmSync(db + s, { force: true })), 400); } };
}
const GOOGLE_ENV = { GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: CLIENT_SECRET, GOOGLE_AUTH_URL: `http://localhost:${FAKE_PORT}/authorize`, GOOGLE_TOKEN_URL: `http://localhost:${FAKE_PORT}/token`, GOOGLE_ISSUER: `http://localhost:${FAKE_PORT}` };

class Browser {
  constructor(base) { this.base = base; this.jar = {}; }
  cookieHeader() { return Object.entries(this.jar).map(([k, v]) => `${k}=${v}`).join('; '); }
  absorb(res) { for (const c of res.headers.getSetCookie?.() || []) { const [kv] = c.split(';'); const i = kv.indexOf('='); const k = kv.slice(0, i), v = kv.slice(i + 1); if (v === '') delete this.jar[k]; else this.jar[k] = v; this.lastSetCookie = { ...(this.lastSetCookie || {}), [k]: c }; } }
  async req(method, path, body, { csrf = true } = {}) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (csrf) headers['X-Requested-With'] = 'hk-admin';
    if (this.cookieHeader()) headers.Cookie = this.cookieHeader();
    const res = await fetch(this.base + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' });
    this.absorb(res);
    let data = {}; try { data = await res.json(); } catch { /* not json */ }
    return { status: res.status, data, res };
  }
  /** Plays the whole browser journey: start → Google's consent screen → back to /callback. */
  async google({ as, sub, name = '', verified = true, badNonce, failToken, dropCookie, setupToken, callbackTwice } = {}) {
    const start = await this.req('POST', '/api/auth/google/start', { token: setupToken });
    if (start.status !== 200) return { start };
    const q = new URLSearchParams({ as, sub, name, verified: String(verified) });
    if (badNonce) q.set('badNonce', '1'); if (failToken) q.set('failToken', '1');
    const consent = await fetch(`${start.data.url}&${q}`, { redirect: 'manual' });            // the user picks an account at "Google"
    const back = consent.headers.get('location');
    const oauthCookie = this.jar.hk_oauth;
    if (dropCookie) delete this.jar.hk_oauth;                                                   // e.g. opened in another browser
    const cb = await fetch(back, { redirect: 'manual', headers: { Cookie: this.cookieHeader() } });
    this.absorb(cb);
    const result = { start, location: cb.headers.get('location'), status: cb.status };
    if (callbackTwice) { const again = await fetch(back, { redirect: 'manual', headers: { Cookie: `hk_oauth=${oauthCookie}` } }); result.replayLocation = again.headers.get('location'); }
    return result;
  }
}
const errOf = (loc) => (loc && new URL(loc, 'http://x').searchParams.get('auth_error')) || null;

/* ───────── 1) normal server, Google configured ───────── */
const s1 = await startServer(8812, GOOGLE_ENV);
try {
  const owner = new Browser(s1.base), stranger = new Browser(s1.base), editor = new Browser(s1.base), pwUser = new Browser(s1.base);

  let r = await owner.req('GET', '/api/auth/status');
  ok('status tells the UI Google is available', r.data.google === true && r.data.setupRequired === true);
  r = await owner.req('POST', '/api/auth/google/start', {}, { csrf: false });
  ok('start without the CSRF header is blocked', r.status === 403);
  r = await owner.req('POST', '/api/auth/google/start', {});
  const url = new URL(r.data.url);
  ok('start returns a proper authorize URL (PKCE S256, state, nonce, openid+email scope)',
    r.status === 200 && url.searchParams.get('code_challenge_method') === 'S256' && url.searchParams.get('state').length >= 30 && url.searchParams.get('nonce') && /openid/.test(url.searchParams.get('scope')) && /email/.test(url.searchParams.get('scope')) && url.searchParams.get('redirect_uri') === 'http://localhost:8812/api/auth/google/callback');
  ok('state cookie is HttpOnly + SameSite=Lax scoped to the Google path', /HttpOnly/i.test(owner.lastSetCookie.hk_oauth) && /SameSite=Lax/i.test(owner.lastSetCookie.hk_oauth) && /Path=\/api\/auth\/google/.test(owner.lastSetCookie.hk_oauth));

  // first account via Google → admin
  let g = await owner.google({ as: 'Owner@Example.com', sub: 'sub-owner', name: 'Olivia Owner', callbackTwice: true });
  ok('first Google sign-in on a fresh site lands in /admin', g.status === 302 && g.location === '/admin', JSON.stringify(g));
  r = await owner.req('GET', '/api/auth/me');
  ok('…and becomes the ADMIN (email lower-cased, name from Google, no password)', r.status === 200 && r.data.user.role === 'admin' && r.data.user.email === 'owner@example.com' && r.data.user.name === 'Olivia Owner' && r.data.user.hasPassword === false && r.data.user.googleLinked === true, JSON.stringify(r.data));
  ok('session cookie is HttpOnly + SameSite=Strict', /HttpOnly/i.test(owner.lastSetCookie.hk_sid) && /SameSite=Strict/i.test(owner.lastSetCookie.hk_sid));
  ok('replaying the same callback (code + state) is refused', errOf(g.replayLocation) === 'expired', String(g.replayLocation));
  r = await owner.req('GET', '/api/auth/status');
  ok('setup is now closed', r.data.setupRequired === false);

  // strangers cannot sign themselves up
  g = await stranger.google({ as: 'stranger@gmail.test', sub: 'sub-stranger', name: 'Sam Stranger' });
  ok('an un-invited Google account is refused (not_invited)', errOf(g.location) === 'not_invited', JSON.stringify(g));
  r = await stranger.req('GET', '/api/auth/me');
  ok('…and gets no session', r.status === 401);
  r = await owner.req('GET', '/api/admin/users');
  ok('…and no account was created', r.data.users.length === 1);

  // invite without a password → signs in with Google
  r = await owner.req('POST', '/api/admin/users', { name: 'Ed Editor', email: 'MixedCase@Example.com', role: 'editor' });
  ok('admin can invite by email with NO password', r.status === 201 && r.data.user.hasPassword === false && r.data.user.googleLinked === false, JSON.stringify(r.data));
  g = await editor.google({ as: 'mixedcase@example.com', sub: 'sub-editor', name: 'Ed E.' });
  r = await editor.req('GET', '/api/auth/me');
  ok('the invited person signs in with Google (case-insensitive match) with the invited role', g.location === '/admin' && r.status === 200 && r.data.user.role === 'editor' && r.data.user.name === 'Ed Editor' && r.data.user.googleLinked === true, JSON.stringify(r.data));
  r = await editor.req('GET', '/api/admin/users');
  ok('an invited editor has editor powers only', r.status === 403);
  r = await editor.req('POST', '/api/auth/password', { current: 'whatever-long', next: 'another-long-password' });
  ok('a Google-only account has no password to change', r.status === 400);
  r = await new Browser(s1.base).req('POST', '/api/auth/login', { email: 'mixedcase@example.com', password: 'anything-at-all-1' });
  ok('a password-less account cannot be entered with any password', r.status === 401);
  r = await owner.req('GET', '/api/admin/users');
  ok('Users list reports how each person signs in', r.data.users.find((u) => u.email === 'mixedcase@example.com').googleLinked === true);
  g = await editor.google({ as: 'mixedcase@example.com', sub: 'sub-editor' });
  ok('signing in again with the same Google account keeps working', g.location === '/admin');

  // existing password account links on first Google login; a different Google identity cannot take it over
  await owner.req('POST', '/api/admin/users', { name: 'Pat Password', email: 'pat@example.com', password: 'pats-long-password', role: 'editor' });
  g = await pwUser.google({ as: 'pat@example.com', sub: 'sub-pat' });
  r = await pwUser.req('GET', '/api/auth/me');
  ok('a password account gets linked on first Google sign-in and keeps its password', g.location === '/admin' && r.data.user.googleLinked === true && r.data.user.hasPassword === true, JSON.stringify(r.data));
  g = await new Browser(s1.base).google({ as: 'pat@example.com', sub: 'sub-someone-else' });
  ok('a different Google identity with the same email cannot take over (account_mismatch)', errOf(g.location) === 'account_mismatch', JSON.stringify(g));

  // tampering + failures
  const t = new Browser(s1.base);
  g = await t.google({ as: 'pat@example.com', sub: 'sub-pat', dropCookie: true });
  ok('a callback without the browser\'s state cookie is refused (login-CSRF)', errOf(g.location) === 'expired', JSON.stringify(g));
  g = await t.google({ as: 'pat@example.com', sub: 'sub-pat', verified: false });
  ok('an unverified Google email is refused', errOf(g.location) === 'unverified_email', JSON.stringify(g));
  g = await t.google({ as: 'pat@example.com', sub: 'sub-pat', badNonce: true });
  ok('an id_token with the wrong nonce is refused', errOf(g.location) === 'google_failed', JSON.stringify(g));
  g = await t.google({ as: 'pat@example.com', sub: 'sub-pat', failToken: true });
  ok('a failing token endpoint is handled gracefully', errOf(g.location) === 'google_failed', JSON.stringify(g));
  const denied = await fetch(`${s1.base}/api/auth/google/callback?error=access_denied`, { redirect: 'manual' });
  ok('user pressing "Cancel" at Google is handled', errOf(denied.headers.get('location')) === 'denied');
  const forged = await fetch(`${s1.base}/api/auth/google/callback?code=abc&state=forged`, { redirect: 'manual', headers: { Cookie: 'hk_oauth=forged' } });
  ok('a forged state is refused', errOf(forged.headers.get('location')) === 'expired');
  ok('none of the failures created a session or a user', (await owner.req('GET', '/api/admin/users')).data.users.length === 3);
  ok('the id_token / secrets are never logged', !s1.log().includes('eyJ') && !s1.log().includes(CLIENT_SECRET) && !s1.log().includes('sub-owner'));
} finally { s1.stop(); }

/* ───────── 2) SETUP_TOKEN protects the first Google sign-in too ───────── */
const s2 = await startServer(8813, { ...GOOGLE_ENV, SETUP_TOKEN: 'my-private-key' });
try {
  const b = new Browser(s2.base);
  let r = await b.req('POST', '/api/auth/google/start', {});
  ok('with SETUP_TOKEN set, Google setup without the key is refused', r.status === 403 && r.data.errors.token);
  r = await b.req('POST', '/api/auth/google/start', { token: 'guess' });
  ok('…and with a wrong key', r.status === 403);
  const g = await b.google({ as: 'boss@example.com', sub: 'sub-boss', name: 'Bo Boss', setupToken: 'my-private-key' });
  r = await b.req('GET', '/api/auth/me');
  ok('…but works with the right key, creating the admin', g.location === '/admin' && r.data.user.role === 'admin');
} finally { s2.stop(); }

/* ───────── 3) Google not configured ───────── */
const s3 = await startServer(8814, {});
try {
  const b = new Browser(s3.base);
  let r = await b.req('GET', '/api/auth/status');
  ok('status says Google is off', r.data.google === false);
  r = await b.req('POST', '/api/auth/google/start', {});
  ok('start is 404 when not configured', r.status === 404);
  const cb = await fetch(`${s3.base}/api/auth/google/callback?code=x&state=y`, { redirect: 'manual' });
  ok('callback redirects with google_off', errOf(cb.headers.get('location')) === 'google_off');
  await b.req('POST', '/api/auth/setup', { name: 'Pw Admin', email: 'pw@example.com', password: 'long-password-here' });
  r = await b.req('POST', '/api/admin/users', { name: 'No Pw', email: 'nopw@example.com', role: 'editor' });
  ok('inviting without a password is refused when Google is not set up', r.status === 400 && r.data.errors.password);
} finally { s3.stop(); }

fake.close();
console.log(`\n${pass} passed, ${fail} failed`);
setTimeout(() => process.exit(fail ? 1 : 0), 600);
