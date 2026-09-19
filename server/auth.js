import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import express from 'express';
import { ROLES } from './db.js';

const scrypt = promisify(scryptCb);
const COOKIE = 'hk_sid';
const SESSION_DAYS = 14;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/* ───────────── passwords ───────────── */
export async function hashPassword(pw) {
  const salt = randomBytes(16);
  const key = await scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt:16384:8:1:${salt.toString('base64')}:${key.toString('base64')}`;
}
export async function verifyPassword(pw, stored) {
  const [alg, N, r, p, salt, key] = String(stored).split(':');
  if (alg !== 'scrypt') return false;
  const want = Buffer.from(key, 'base64');
  const got = await scrypt(pw, Buffer.from(salt, 'base64'), want.length, { N: +N, r: +r, p: +p });
  return timingSafeEqual(got, want);
}
const DUMMY_HASH = await hashPassword('dummy-password-for-timing');   // burns the same time for unknown emails

export function passwordProblem(pw, email) {
  if (typeof pw !== 'string' || pw.length < 10) return 'Use at least 10 characters.';
  if (pw.length > 200) return 'That password is too long.';
  if (email && pw.toLowerCase() === String(email).toLowerCase()) return "Your password can't be your email address.";
  if (/^(.)\1+$/.test(pw)) return 'Please choose a less repetitive password.';
  return null;
}

/* ───────────── tiny failure counter (login brute-force protection) ───────────── */
function failureCounter() {
  const m = new Map();
  const recent = (k, win) => (m.get(k) || []).filter((t) => Date.now() - t < win);
  return {
    blocked: (k, max, win) => recent(k, win).length >= max,
    add: (k, win) => m.set(k, [...recent(k, win), Date.now()]),
    clear: (k) => m.delete(k),
    sweep: () => { for (const k of m.keys()) if (!recent(k, 3_600_000).length) m.delete(k); },
  };
}

/* ───────────── sessions ───────────── */
const sha = (s) => createHash('sha256').update(s).digest('hex');
export const parseCookies = (h = '') => Object.fromEntries(h.split(';').map((c) => c.trim().split(/=(.*)/s).slice(0, 2)).filter(([k]) => k));

export function createAuth(store, { isProd, originAllowed, hashIp }) {
  const fails = failureCounter();
  setInterval(fails.sweep, 600_000).unref();
  const WIN = 15 * 60_000;
  let settingUp = false;                                       // serialises the "first account" race

  const setCookie = (res, token, maxAgeSec) =>
    res.append('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${isProd ? '; Secure' : ''}`);
  const clearCookie = (res) => setCookie(res, '', 0);

  async function startSession(req, res, userId) {
    const token = randomBytes(32).toString('base64url');
    const exp = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
    await store.createSession(userId, sha(token), exp, String(req.get('user-agent') || '').slice(0, 200));
    setCookie(res, token, SESSION_DAYS * 86400);
  }

  /** Attaches req.user (and req.sessionHash) when the cookie holds a valid session. */
  async function authenticate(req, res, next) {
    try {
      const token = parseCookies(req.get('cookie'))[COOKIE];
      if (token) {
        const h = sha(token);
        const u = await store.sessionUser(h);
        if (u) {
          req.user = u; req.sessionHash = h;
          if (new Date(u.expiresAt) - Date.now() < (SESSION_DAYS - 1) * 864e5) {             // sliding expiry, at most once a day
            const exp = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
            store.extendSession(h, exp).catch(() => {}); setCookie(res, token, SESSION_DAYS * 86400);
          }
        }
      }
      next();
    } catch (e) { next(e); }
  }

  const requireUser = (req, res, next) => (req.user ? next() : res.status(401).json({ ok: false, error: 'Please sign in.' }));
  const requireAdmin = (req, res, next) => (!req.user ? res.status(401).json({ ok: false, error: 'Please sign in.' })
    : req.user.role === 'admin' ? next() : res.status(403).json({ ok: false, error: 'Only admins can do that.' }));

  /** Blocks cross-site state changes: custom header (needs a CORS preflight to forge) + Origin check + SameSite=Strict cookie. */
  function csrf(req, res, next) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (req.get('x-requested-with') !== 'hk-admin' || !originAllowed(req)) return res.status(403).json({ ok: false, error: 'Request blocked.' });
    next();
  }

  /** Runs `fn` only if no other setup is in flight (used by password AND Google first-account setup). */
  async function withSetupLock(fn) {
    if (settingUp) return { locked: true };
    settingUp = true;
    try { return { value: await fn() }; } finally { settingUp = false; }
  }

  const asyncH = (fn) => (req, res, next) => fn(req, res, next).catch(next);
  const cleanName = (v) => String(v ?? '').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
  const cleanEmail = (v) => String(v ?? '').trim().toLowerCase();
  const validateAccount = ({ name, email, password }, { needPassword = true } = {}) => {
    const errors = {};
    if (cleanName(name).length < 2 || cleanName(name).length > 80) errors.name = 'Please enter a name (2–80 characters).';
    if (!EMAIL_RE.test(cleanEmail(email)) || cleanEmail(email).length > 254) errors.email = 'Please enter a valid email address.';
    const pw = needPassword ? passwordProblem(password, cleanEmail(email)) : null;     // Google-only invites have no password
    if (pw) errors.password = pw;
    return errors;
  };

  const router = express.Router();
  router.use(express.json({ limit: '10kb' }), csrf);

  router.get('/status', asyncH(async (req, res) => {
    res.json({ setupRequired: (await store.userCount()) === 0, setupTokenRequired: Boolean(process.env.SETUP_TOKEN), google: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) });
  }));

  // First account ever → admin. Closed permanently once any user exists.
  router.post('/setup', asyncH(async (req, res) => {
    const ip = `setup:${hashIp(req.ip)}`;
    if (fails.blocked(ip, 8, WIN)) return res.status(429).json({ ok: false, error: 'Too many attempts. Try again later.' });
    if (settingUp || (await store.userCount()) > 0) return res.status(403).json({ ok: false, error: 'Setup has already been completed. Please sign in.' });
    const need = process.env.SETUP_TOKEN;
    if (need) {
      const given = Buffer.from(String(req.body?.token ?? '')), want = Buffer.from(need);
      if (given.length !== want.length || !timingSafeEqual(given, want)) { fails.add(ip, WIN); return res.status(403).json({ ok: false, errors: { token: 'That setup key is not correct.' } }); }
    }
    const errors = validateAccount(req.body || {});
    if (Object.keys(errors).length) return res.status(400).json({ ok: false, errors });

    if (settingUp) return res.status(403).json({ ok: false, error: 'Setup is already in progress.' });
    settingUp = true;                                          // check + set with no await between = atomic
    try {
      if ((await store.userCount()) > 0) return res.status(403).json({ ok: false, error: 'Setup has already been completed. Please sign in.' });
      const id = await store.createUser({ email: cleanEmail(req.body.email), name: cleanName(req.body.name), passwordHash: await hashPassword(req.body.password), role: 'admin' });
      await store.touchLogin(id);
      await startSession(req, res, id);
      res.status(201).json({ ok: true, user: await store.userById(id) });
    } finally { settingUp = false; }
  }));

  router.post('/login', asyncH(async (req, res) => {
    const email = cleanEmail(req.body?.email), pw = String(req.body?.password ?? '');
    const ipK = `ip:${hashIp(req.ip)}`, emK = `em:${email}`;
    if (fails.blocked(ipK, 10, WIN) || fails.blocked(emK, 5, WIN)) return res.status(429).json({ ok: false, error: 'Too many failed attempts. Please wait 15 minutes and try again.' });
    const row = email && pw.length <= 200 ? await store.userByEmail(email) : null;
    const usable = Boolean(row && String(row.password_hash).startsWith('scrypt:'));
    const ok = (await verifyPassword(pw, usable ? row.password_hash : DUMMY_HASH)) && usable;
    if (!row || !ok) { fails.add(ipK, WIN); fails.add(emK, WIN); return res.status(401).json({ ok: false, error: 'Incorrect email or password.' }); }
    fails.clear(emK);
    await store.touchLogin(row.id);
    await startSession(req, res, row.id);
    res.json({ ok: true, user: await store.userById(row.id) });
  }));

  router.post('/logout', asyncH(async (req, res) => {
    if (req.sessionHash) await store.deleteSession(req.sessionHash);
    clearCookie(res); res.json({ ok: true });
  }));

  router.get('/me', (req, res) => (req.user ? res.json({ ok: true, user: { id: req.user.id, email: req.user.email, name: req.user.name, role: req.user.role, hasPassword: req.user.hasPassword, googleLinked: req.user.googleLinked } }) : res.status(401).json({ ok: false })));

  router.post('/password', requireUser, asyncH(async (req, res) => {
    const row = await store.userWithHash(req.user.id);
    if (!req.user.hasPassword) return res.status(400).json({ ok: false, error: 'Your account signs in with Google, so it has no password to change.' });
    if (fails.blocked(`pw:${req.user.id}`, 5, WIN)) return res.status(429).json({ ok: false, error: 'Too many attempts. Please wait a few minutes.' });
    if (!(await verifyPassword(String(req.body?.current ?? ''), row.password_hash))) { fails.add(`pw:${req.user.id}`, WIN); return res.status(400).json({ ok: false, errors: { current: 'Your current password is not correct.' } }); }
    const problem = passwordProblem(req.body?.next, req.user.email);
    if (problem) return res.status(400).json({ ok: false, errors: { next: problem } });
    await store.updateUser(req.user.id, { passwordHash: await hashPassword(req.body.next) });
    await store.deleteUserSessions(req.user.id, req.sessionHash);        // sign out everywhere else
    res.json({ ok: true });
  }));

  /* ── user management (admins) ── */
  const users = express.Router();
  users.use(requireAdmin);
  users.get('/', asyncH(async (req, res) => res.json({ users: await store.listUsers() })));

  users.post('/', express.json({ limit: '10kb' }), asyncH(async (req, res) => {
    const role = ROLES.includes(req.body?.role) ? req.body.role : 'editor';
    const invite = !req.body?.password;                               // no password = they sign in with Google
    const errors = validateAccount(req.body || {}, { needPassword: !invite });
    if (Object.keys(errors).length) return res.status(400).json({ ok: false, errors });
    if (invite && !(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET)) return res.status(400).json({ ok: false, errors: { password: 'Google sign-in is not set up on this server, so please give them a temporary password.' } });
    if (await store.userByEmail(cleanEmail(req.body.email))) return res.status(409).json({ ok: false, errors: { email: 'A user with that email already exists.' } });
    const id = await store.createUser({ email: cleanEmail(req.body.email), name: cleanName(req.body.name), passwordHash: invite ? '' : await hashPassword(req.body.password), role });
    res.status(201).json({ ok: true, user: await store.userById(id) });
  }));

  users.patch('/:id', express.json({ limit: '10kb' }), asyncH(async (req, res) => {
    const id = +req.params.id, target = await store.userById(id);
    if (!target) return res.status(404).json({ ok: false, error: 'User not found.' });
    const patch = {};
    if (req.body?.name !== undefined) { const n = cleanName(req.body.name); if (n.length < 2 || n.length > 80) return res.status(400).json({ ok: false, errors: { name: 'Please enter a name (2–80 characters).' } }); patch.name = n; }
    if (req.body?.role !== undefined) {
      if (!ROLES.includes(req.body.role)) return res.status(400).json({ ok: false, errors: { role: 'Unknown role.' } });
      if (target.role === 'admin' && req.body.role !== 'admin' && (await store.adminCount()) <= 1) return res.status(400).json({ ok: false, error: 'There must always be at least one admin.' });
      patch.role = req.body.role;
    }
    if (req.body?.password !== undefined) {
      const problem = passwordProblem(req.body.password, target.email);
      if (problem) return res.status(400).json({ ok: false, errors: { password: problem } });
      patch.passwordHash = await hashPassword(req.body.password);
    }
    await store.updateUser(id, patch);
    if (patch.passwordHash || patch.role) await store.deleteUserSessions(id, id === req.user.id ? req.sessionHash : undefined);
    res.json({ ok: true, user: await store.userById(id) });
  }));

  users.delete('/:id', asyncH(async (req, res) => {
    const id = +req.params.id, target = await store.userById(id);
    if (!target) return res.status(404).json({ ok: false, error: 'User not found.' });
    if (id === req.user.id) return res.status(400).json({ ok: false, error: "You can't delete your own account." });
    if (target.role === 'admin' && (await store.adminCount()) <= 1) return res.status(400).json({ ok: false, error: 'There must always be at least one admin.' });
    await store.deleteUser(id);
    res.json({ ok: true });
  }));

  return { authenticate, requireUser, requireAdmin, csrf, router, users, asyncH, startSession, withSetupLock, cleanName };
}
