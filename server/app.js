import express from 'express';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore, STATUSES } from './db.js';
import { createMailer } from './mail.js';
import { validateEnquiry } from './validate.js';
import { createAuth } from './auth.js';
import { createGoogle } from './google.js';
import { createLimiter } from './limits.js';
import { DEFAULT_CONTENT, sanitizeContent, withDefaults } from './content.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Builds the whole Express app. It runs in two places:
 *   • server/index.js  — a normal long-running Node server (Render, a VPS, your laptop)
 *   • api/index.js     — a Vercel serverless function
 * so NOTHING that another copy of the server would need to see may live in memory: rate limits, login lock-out, the
 * "first account" lock, sessions and the site content all live in the database (content is re-read every few seconds).
 * Environment variables are read here, at call time, so index.js can load .env first.
 */
export async function createApp() {
  const IS_PROD = process.env.NODE_ENV === 'production';
  const HASH_SALT = process.env.IP_HASH_SALT || 'hkdevlab';
  const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const CONTENT_TTL = +process.env.CONTENT_TTL_MS || 5000;

  const store = await createStore();
  const mailer = createMailer();
  const limiter = createLimiter(store);
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);                      // correct client IP behind Vercel / Render / nginx
  const asyncH = (fn) => (req, res, next) => fn(req, res, next).catch(next);

  /* ───────────── site content: database is the source of truth, cached for a few seconds ───────────── */
  let cache = null;                                // { at, content, meta }
  async function site() {
    if (cache && Date.now() - cache.at < CONTENT_TTL) return cache;
    const row = await store.getContent();
    if (!row) {
      await store.saveContent(DEFAULT_CONTENT, 'system', 'Initial content');
      cache = { at: Date.now(), content: DEFAULT_CONTENT, meta: {} };
    } else {
      cache = { at: Date.now(), content: withDefaults(row.data), meta: { updatedAt: row.updatedAt, updatedBy: row.updatedBy } };
    }
    return cache;
  }
  const remember = (content, updatedAt, updatedBy) => { cache = { at: Date.now(), content, meta: { updatedAt, updatedBy } }; };

  /* ───────────── security headers ───────────── */
  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self' mailto:",
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      ...(IS_PROD ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}),
    });
    next();
  });

  /* ───────────── helpers ───────────── */
  const hashIp = (ip) => createHash('sha256').update(`${HASH_SALT}:${ip}`).digest('hex').slice(0, 24);   // no raw IPs / emails stored in limits

  // Cross-site protection: a browser always sets Origin on cross-site POSTs and a page can't forge it.
  // Accept it when it matches the host the visitor used (directly or via a proxy's X-Forwarded-Host).
  const DEV_ORIGINS = IS_PROD ? [] : ['http://localhost:5180', 'http://127.0.0.1:5180'];
  function originAllowed(req) {
    const origin = req.get('origin');
    if (!origin) return true;                     // same-origin requests from some browsers omit it
    try {
      const host = new URL(origin).host;
      return [req.get('host'), req.get('x-forwarded-host')].includes(host) || ALLOWED_ORIGINS.includes(origin) || DEV_ORIGINS.includes(origin);
    } catch { return false; }
  }

  const auth = createAuth(store, { isProd: IS_PROD, originAllowed, hashIp, limiter });
  const google = createGoogle(store, auth, { isProd: IS_PROD, hashIp, limiter });

  /* ───────────── health + public content ───────────── */
  app.get('/api/health', async (req, res) => {
    try { await store.ping(); res.json({ ok: true, db: store.kind, mail: mailer.live ? 'smtp' : 'console (SMTP not configured)' }); }
    catch { res.status(503).json({ ok: false }); }
  });
  app.get('/api/content', asyncH(async (req, res) => res.set('Cache-Control', 'no-cache').json((await site()).content)));

  /* ───────────── contact form ───────────── */
  app.post('/api/contact', express.json({ limit: '20kb' }), asyncH(async (req, res) => {
    if (!originAllowed(req)) return res.status(403).json({ ok: false, error: 'Forbidden.' });

    const ipHash = hashIp(req.ip);
    if (await limiter.take(`c:${ipHash}`, 5, 15 * 60_000)) {
      return res.status(429).json({ ok: false, error: 'Too many messages from your connection. Please try again in a few minutes, or email us directly.' });
    }

    // Bots: a filled honeypot or a form "submitted" faster than a human can type. Pretend success, store nothing.
    const elapsed = Number(req.body?.elapsed);
    if (req.body?.website || (Number.isFinite(elapsed) && elapsed < 2500)) return res.status(201).json({ ok: true });

    const { content } = await site();
    const { errors, value } = validateEnquiry(req.body, content.contact.formTypes);
    if (errors) return res.status(400).json({ ok: false, errors });

    let id;
    try {
      id = await store.insert({ ...value, ipHash, userAgent: String(req.get('user-agent') || '').slice(0, 300) });
    } catch (err) {
      console.error('[contact] store failed:', err);
      return res.status(500).json({ ok: false, error: `Something went wrong on our side. Please email us at ${mailer.to}.` });
    }
    // The message is safely stored. Now send the emails BEFORE answering: a serverless function is frozen the moment it
    // responds, so a "background" email would never leave. Capped so a slow mail server can't hang the visitor.
    try {
      const timeout = new Promise((r) => setTimeout(() => r(false), 9000).unref?.());
      const sent = await Promise.race([mailer.sendEnquiry({ id, ...value }), timeout]);
      await store.setEmailed(id, sent);
    } catch (err) { console.error('[mail] unexpected:', err.message); }
    res.status(201).json({ ok: true, id });
  }));

  /* ───────────── accounts + admin API ───────────── */
  app.use(['/api/auth', '/api/admin'], (req, res, next) => { res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' }); next(); });
  app.use(['/api/auth', '/api/admin'], asyncH(async (req, res, next) => auth.authenticate(req, res, next)));
  app.use('/api/auth/google', google.router);          // before the generic auth router (own CSRF handling)
  app.use('/api/auth', auth.router);

  const admin = express.Router();
  admin.use(auth.requireUser, express.json({ limit: '300kb' }), auth.csrf);
  admin.use('/users', auth.users);

  // enquiries (admins and editors)
  admin.get('/enquiries', asyncH(async (req, res) => {
    const status = STATUSES.includes(req.query.status) ? req.query.status : undefined;
    const [items, counts] = await Promise.all([store.list({ status, limit: Math.min(+req.query.limit || 200, 500), offset: +req.query.offset || 0 }), store.counts()]);
    res.json({ items, counts });
  }));
  admin.patch('/enquiries/:id', asyncH(async (req, res) => {
    if (!STATUSES.includes(req.body?.status)) return res.status(400).json({ ok: false });
    res.json({ ok: await store.setStatus(+req.params.id, req.body.status) });
  }));
  admin.delete('/enquiries/:id', asyncH(async (req, res) => res.json({ ok: await store.remove(+req.params.id) })));
  admin.get('/export.csv', asyncH(async (req, res) => {
    const cell = (v) => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; return `"${s.replace(/"/g, '""')}"`; };   // also blocks spreadsheet formula injection
    const rows = await store.list({ limit: 100000 });
    const csv = ['id,created_at,status,name,email,service,message', ...rows.map((r) => [r.id, r.created_at, r.status, r.name, r.email, r.service, r.message].map(cell).join(','))].join('\n');
    res.type('text/csv').set('Content-Disposition', 'attachment; filename="hkdevlab-enquiries.csv"').send(csv);
  }));

  // site content (admins and editors) — always read fresh here so an editor never overwrites a newer save with stale data
  admin.get('/content', asyncH(async (req, res) => {
    const row = await store.getContent();
    res.json({ content: row ? withDefaults(row.data) : DEFAULT_CONTENT, updatedAt: row?.updatedAt, updatedBy: row?.updatedBy });
  }));
  admin.put('/content', asyncH(async (req, res) => {
    const { errors, value } = sanitizeContent(req.body?.content);
    if (errors) return res.status(400).json({ ok: false, errors });
    const at = await store.saveContent(value, req.user.email, String(req.body?.note ?? '').slice(0, 120));
    remember(value, at, req.user.email);
    res.json({ ok: true, content: value, updatedAt: at, updatedBy: req.user.email });
  }));
  admin.get('/content/versions', asyncH(async (req, res) => res.json({ versions: await store.listVersions() })));
  admin.post('/content/restore/:id', asyncH(async (req, res) => {
    const old = await store.getVersion(+req.params.id);
    if (!old) return res.status(404).json({ ok: false, error: 'Version not found.' });
    const { errors, value } = sanitizeContent(withDefaults(old));
    if (errors) return res.status(422).json({ ok: false, errors });
    const at = await store.saveContent(value, req.user.email, `Restored version #${req.params.id}`);
    remember(value, at, req.user.email);
    res.json({ ok: true, content: value, updatedAt: at, updatedBy: req.user.email });
  }));
  app.use('/api/admin', admin);

  /* ───────────── the admin portal (static UI; every action behind the API above) ───────────── */
  app.use('/admin', (req, res, next) => { res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' }); next(); });
  app.get('/admin/schema.js', (req, res) => res.type('js').sendFile(resolve(root, 'content/schema.js')));
  app.get(['/admin', '/admin/'], (req, res) => res.sendFile(resolve(root, 'server/admin/index.html')));
  app.use('/admin', express.static(resolve(root, 'server/admin'), { index: false }));

  app.use('/api', (req, res) => res.status(404).json({ ok: false }));

  /* ───────────── the public site, when this server is also the web server (not on Vercel: its CDN serves dist/) ───────────── */
  const hasDist = existsSync(dist);
  if (hasDist) {
    let indexCache = null;                         // { stamp, html }
    const renderIndex = ({ content, meta }) => {
      if (indexCache && indexCache.stamp === meta.updatedAt) return indexCache.html;
      const safeJson = JSON.stringify(content).replace(/</g, `${String.fromCharCode(92)}u003c`);   // can't break out of the <script>
      const html = readFileSync(resolve(dist, 'index.html'), 'utf8')
        .replace('<!--SITE_CONTENT-->', `<script type="application/json" id="site-content">${safeJson}</script>`)
        .replace(/<title>[\s\S]*?<\/title>/, () => `<title>${esc(content.seo.title)}</title>`)
        .replace(/(<meta name="description" content=")[^"]*(")/, (m, a, b) => `${a}${esc(content.seo.description)}${b}`)
        .replace(/(<meta property="og:title" content=")[^"]*(")/, (m, a, b) => `${a}${esc(content.seo.title)}${b}`)
        .replace(/(<meta property="og:description" content=")[^"]*(")/, (m, a, b) => `${a}${esc(content.seo.description)}${b}`);
      indexCache = { stamp: meta.updatedAt, html };
      return html;
    };
    app.use(express.static(dist, {
      index: false,
      setHeaders: (res, file) => res.set('Cache-Control', /[\\/]assets[\\/]/.test(file) ? 'public, max-age=31536000, immutable' : 'public, max-age=3600'),
    }));
    app.get('/', asyncH(async (req, res) => res.set('Cache-Control', 'no-cache').type('html').send(renderIndex(await site()))));
  }
  app.use((req, res) => res.status(404).type('text').send('Not found'));
  app.use((err, req, res, next) => {                              // bad JSON, oversize body…
    if (res.headersSent) return next(err);
    if (!err.status || err.status >= 500) console.error('[server]', err);
    res.status(err.status && err.status < 500 ? err.status : 500).json({ ok: false, error: err.status && err.status < 500 ? 'Bad request.' : 'Something went wrong.' });
  });

  await site();                                    // seeds the default content on first ever start
  return { app, store, mailer, hasDist };
}
