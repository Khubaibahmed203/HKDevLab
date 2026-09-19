import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import express from 'express';
import { parseCookies } from './auth.js';

/**
 * "Continue with Google" — OAuth 2.0 authorization-code flow with PKCE (+ state and nonce), done on the server.
 *
 * Who may sign in:
 *   • the very first account (no users yet) → becomes the admin (needs SETUP_TOKEN too, if one is set)
 *   • anyone an admin has added by email (Users → Add a user, no password)  → signs in with that role
 *   • anyone else is refused and nothing is created — Google accounts cannot sign themselves up.
 *
 * Setup: Google Cloud Console → OAuth client (Web) → redirect URI  {PUBLIC_URL}/api/auth/google/callback
 * Env: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, PUBLIC_URL. (GOOGLE_AUTH_URL / GOOGLE_TOKEN_URL / GOOGLE_ISSUER exist for tests.)
 */
const COOKIE = 'hk_oauth';
const sha = (s) => createHash('sha256').update(s).digest();
const b64url = (buf) => Buffer.from(buf).toString('base64url');
const safeEqual = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };
export const googleEnabled = () => Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

export function createGoogle(store, auth, { isProd, hashIp }) {
  const AUTH_URL = process.env.GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth';
  const TOKEN_URL = process.env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token';
  const ISSUERS = ['https://accounts.google.com', 'accounts.google.com', process.env.GOOGLE_ISSUER].filter(Boolean);
  const { asyncH } = auth;
  const router = express.Router();

  // tiny per-visitor limiter for the start / callback endpoints
  const seen = new Map();
  const limited = (key, max) => {
    const now = Date.now();
    const recent = (seen.get(key) || []).filter((t) => now - t < 15 * 60_000);
    recent.push(now); seen.set(key, recent);
    return recent.length > max;
  };
  setInterval(() => { const now = Date.now(); for (const [k, v] of seen) if (!v.some((t) => now - t < 900_000)) seen.delete(k); }, 600_000).unref();

  const publicUrl = (req) => (process.env.PUBLIC_URL || '').replace(/\/$/, '')
    || (isProd ? `${req.protocol}://${req.get('x-forwarded-host') || req.get('host')}` : 'http://localhost:5180');
  const redirectUri = (req) => `${publicUrl(req)}/api/auth/google/callback`;
  const stateCookie = (res, value, maxAge) =>
    // Lax (not Strict): the cookie must come back on the cross-site redirect from Google
    res.append('Set-Cookie', `${COOKIE}=${value}; Path=/api/auth/google; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isProd ? '; Secure' : ''}`);

  /** 1) The admin page asks for a Google URL (POST so a setup key never appears in a URL). */
  router.post('/start', express.json({ limit: '2kb' }), auth.csrf, asyncH(async (req, res) => {
    if (!googleEnabled()) return res.status(404).json({ ok: false, error: 'Google sign-in is not set up.' });
    if (limited(`gs:${hashIp(req.ip)}`, 20)) return res.status(429).json({ ok: false, error: 'Too many attempts. Please wait a few minutes.' });

    const setup = (await store.userCount()) === 0;
    if (setup && process.env.SETUP_TOKEN && !safeEqual(req.body?.token ?? '', process.env.SETUP_TOKEN)) {
      return res.status(403).json({ ok: false, errors: { token: 'That setup key is not correct.' } });
    }
    const state = b64url(randomBytes(24)), verifier = b64url(randomBytes(32)), nonce = b64url(randomBytes(16));
    await store.createOAuthState({ hash: b64url(sha(state)), verifier, nonce, setupOk: setup, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() });
    stateCookie(res, state, 600);
    const params = new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID, redirect_uri: redirectUri(req), response_type: 'code', scope: 'openid email profile',
      state, nonce, code_challenge: b64url(sha(verifier)), code_challenge_method: 'S256', prompt: 'select_account',
    });
    res.json({ ok: true, url: `${AUTH_URL}?${params}` });
  }));

  /** 2) Google sends the browser back here with ?code&state. */
  router.get('/callback', asyncH(async (req, res) => {
    const fail = (code) => { stateCookie(res, '', 0); res.redirect(`/admin?auth_error=${code}`); };
    if (!googleEnabled()) return fail('google_off');
    if (limited(`gc:${hashIp(req.ip)}`, 30)) return fail('too_many');
    if (req.query.error) return fail(req.query.error === 'access_denied' ? 'denied' : 'google_failed');

    const state = String(req.query.state || ''), code = String(req.query.code || '');
    const cookieState = parseCookies(req.get('cookie'))[COOKIE] || '';
    if (!state || !code || !cookieState || !safeEqual(state, cookieState)) return fail('expired');       // not the browser that started it
    const attempt = await store.takeOAuthState(b64url(sha(state)));                                      // single use
    if (!attempt) return fail('expired');

    let claims;
    try {
      const r = await fetch(TOKEN_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(10_000),
        body: new URLSearchParams({
          code, client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET,
          redirect_uri: redirectUri(req), grant_type: 'authorization_code', code_verifier: attempt.verifier,
        }),
      });
      const tok = await r.json();
      if (!r.ok || typeof tok.id_token !== 'string') throw new Error(tok.error || `token endpoint ${r.status}`);
      // The token came straight from Google's token endpoint over TLS, so (per OpenID Connect Core §3.1.3.7)
      // its signature need not be re-checked — but every claim must be.
      claims = JSON.parse(Buffer.from(tok.id_token.split('.')[1], 'base64url').toString('utf8'));
    } catch (e) { console.error('[google] token exchange failed:', e.message); return fail('google_failed'); }

    const aud = [].concat(claims.aud);
    if (!ISSUERS.includes(claims.iss) || !aud.includes(process.env.GOOGLE_CLIENT_ID) || !(claims.exp * 1000 > Date.now())
        || claims.nonce !== attempt.nonce || typeof claims.sub !== 'string' || typeof claims.email !== 'string') return fail('google_failed');
    if (claims.email_verified !== true && claims.email_verified !== 'true') return fail('unverified_email');

    const email = claims.email.trim().toLowerCase();
    let user = await store.userByGoogleSub(claims.sub);
    if (!user) {
      const invited = await store.userByEmail(email);
      if (invited) {
        if (invited.google_sub && invited.google_sub !== claims.sub) return fail('account_mismatch');   // that email is bound to another Google identity
        await store.linkGoogle(invited.id, claims.sub);
        user = invited;
      }
    }
    if (!user) {
      if ((await store.userCount()) > 0) return fail('not_invited');                                       // nobody signs themselves up
      if (!attempt.setupOk) return fail('setup_key');
      const made = await auth.withSetupLock(async () => {                                                  // first account → admin (race-safe)
        if ((await store.userCount()) > 0) return null;
        const name = auth.cleanName(claims.name) || email.split('@')[0];
        const id = await store.createUser({ email, name, passwordHash: '', role: 'admin' });
        await store.linkGoogle(id, claims.sub);
        return { id };
      });
      if (!made.value) return fail('not_invited');
      user = made.value;
    }

    await store.touchLogin(user.id);
    await auth.startSession(req, res, user.id);
    stateCookie(res, '', 0);
    res.redirect('/admin');
  }));

  return { router };
}
