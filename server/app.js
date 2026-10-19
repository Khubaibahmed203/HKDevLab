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
import { createSeoRouter } from './seo/routes.js';
import { injectSeo } from '../content/seo.js';
import { publicContent } from '../content/visibility.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');

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
    let row = await store.getContent();
    // first start only: create the default document if there is none. Insert-only — it can never replace content that appeared meanwhile.
    if (!row && await store.seedContentIfAbsent(DEFAULT_CONTENT, 'system', 'Initial content')) {
      cache = { at: Date.now(), content: DEFAULT_CONTENT, meta: {} };
      return cache;
    }
    row ||= await store.getContent();                // another server created it first: use that one
    cache = row
      ? { at: Date.now(), content: withDefaults(row.data), meta: { updatedAt: row.updatedAt, updatedBy: row.updatedBy } }
      : { at: Date.now(), content: DEFAULT_CONTENT, meta: {} };
    return cache;
  }
  const remember = (content, updatedAt, updatedBy) => { cache = { at: Date.now(), content, meta: { updatedAt, updatedBy } }; };

  /* ───────────── security headers ───────────── */
  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self'; connect-src 'self'; frame-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self' mailto:",
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
  // Only the adapter name is public: store.kind for SQLite also carries the absolute path of the database file.
  const publicDbName = (kind) => (kind === 'postgres' ? 'postgres' : String(kind).startsWith('sqlite') ? 'sqlite' : 'unknown');
  app.get('/api/health', async (req, res) => {
    try { await store.ping(); res.json({ ok: true, db: publicDbName(store.kind), mail: mailer.live ? 'smtp' : 'console (SMTP not configured)' }); }
    catch { res.status(503).json({ ok: false }); }
  });
  // what visitors get: drafts and un-featured concepts are removed here, on the server, so they never reach the browser
  app.get('/api/content', asyncH(async (req, res) => res.set('Cache-Control', 'no-cache').json(publicContent((await site()).content))));

  /* ───────────── contact form ───────────── */
  // Vercel sets VERCEL_ENV to production | preview | development (NODE_ENV is "production" on all three, so it cannot tell a Preview apart); it is absent on Render, a VPS and
  // local runs, which therefore behave exactly as before. A Preview/Development deployment must never store or email a real visitor's details, so anything but "production" is
  // refused here — FIRST, before the body is parsed, the rate limiter is touched or anything is validated, stored or mailed — with an honest error (not a fake success). Nothing is logged.
  const contactDisabledOnPreview = (req, res, next) => {
    const env = process.env.VERCEL_ENV;
    if (!env || env === 'production') return next();
    res.status(503).set('Cache-Control', 'no-store').json({ ok: false, error: 'Contact submissions are disabled on preview deployments. Nothing was saved or sent.' });
  };
  app.post('/api/contact', contactDisabledOnPreview, express.json({ limit: '20kb' }), asyncH(async (req, res) => {
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
  admin.use('/seo', createSeoRouter(store, { limiter }));

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

  // site content (admins and editors). Every save is a compare-and-swap: the editor sends back the `version` it was given with the
  // document, and a save made from an out-of-date copy (someone else saved, a version was restored, an SEO fix was applied) is
  // refused with 409 instead of silently overwriting the newer content. The version is required — there is no way around it.
  admin.get('/content', asyncH(async (req, res) => {
    const row = await store.getContent();
    res.json({ content: row ? withDefaults(row.data) : DEFAULT_CONTENT, updatedAt: row?.updatedAt, updatedBy: row?.updatedBy, version: row ? row.version : 0 });
  }));
  admin.put('/content', asyncH(async (req, res) => {
    const version = req.body?.version;
    if (!Number.isInteger(version) || version < 0) return res.status(400).json({ ok: false, error: 'This page is out of date — reload it, then save again.' });
    const { errors, value } = sanitizeContent(req.body?.content);
    if (errors) return res.status(400).json({ ok: false, errors });
    const saved = await store.saveContentIfVersion(value, req.user.email, String(req.body?.note ?? '').slice(0, 120), version);
    if (!saved.ok) return res.status(409).json({ ok: false, error: 'The site content was changed after you opened it (by another editor, a restored version or an applied SEO fix), so nothing was saved. Reload this page to see the latest content, then make your changes again.' });
    remember(value, saved.updatedAt, req.user.email);
    res.json({ ok: true, content: value, updatedAt: saved.updatedAt, updatedBy: req.user.email, version: saved.version });
  }));
  // photo upload (admins and editors): the raw image bytes in the request body. The type is decided from the FILE'S OWN
  // first bytes — never from what the browser claims — and only JPEG / PNG / WebP are accepted (no SVG: it can carry script).
  const sniff = (b) => {
    if (b.length > 12 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
    if (b.length > 12 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
    if (b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
    return null;
  };
  admin.post('/media', express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: '1.5mb' }), asyncH(async (req, res) => {
    if (await limiter.take(`m:${req.user.id}`, 30, 10 * 60_000)) return res.status(429).json({ ok: false, error: 'Too many uploads — please wait a few minutes.' });
    const bytes = req.body;
    const mime = Buffer.isBuffer(bytes) ? sniff(bytes) : null;
    if (!mime) return res.status(415).json({ ok: false, error: 'Please choose a JPG, PNG or WebP photo.' });
    const id = createHash('sha256').update(bytes).digest('hex').slice(0, 32);
    await store.saveMedia({ id, mime, bytes, by: req.user.email });
    res.status(201).json({ ok: true, url: `/media/${id}` });
  }));

  admin.get('/content/versions', asyncH(async (req, res) => res.json({ versions: await store.listVersions() })));
  admin.post('/content/restore/:id', asyncH(async (req, res) => {
    const old = await store.getVersion(+req.params.id);
    if (!old) return res.status(404).json({ ok: false, error: 'Version not found.' });
    const { errors, value } = sanitizeContent(withDefaults(old));
    if (errors) return res.status(422).json({ ok: false, errors });
    // Restore replaces the whole document on purpose, so the person does not send a version — the server takes the current one itself,
    // just now. It still goes through the same compare-and-swap, which is what moves the version on and so makes every editor
    // (and SEO fix) that is holding an older copy get a 409 rather than overwrite the restored content.
    const row = await store.getContent();
    const saved = await store.saveContentIfVersion(value, req.user.email, `Restored version #${req.params.id}`, row ? row.version : 0);
    if (!saved.ok) return res.status(409).json({ ok: false, error: 'The site content changed while this version was being restored, so nothing was changed. Try restoring it again.' });
    remember(value, saved.updatedAt, req.user.email);
    res.json({ ok: true, content: value, updatedAt: saved.updatedAt, updatedBy: req.user.email, version: saved.version });
  }));
  app.use('/api/admin', admin);

  /* ───────────── the admin portal (static UI; every action behind the API above) ───────────── */
  app.use('/admin', (req, res, next) => { res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' }); next(); });
  app.get('/admin/schema.js', (req, res) => res.type('js').sendFile(resolve(root, 'content/schema.js')));
  app.get(['/admin', '/admin/'], (req, res) => res.sendFile(resolve(root, 'server/admin/index.html')));
  app.use('/admin', express.static(resolve(root, 'server/admin'), { index: false }));

  // uploaded photos are public (they appear on the site). Address = hash of the bytes, so they can be cached for good.
  app.get('/media/:id', asyncH(async (req, res) => {
    if (!/^[a-f0-9]{32}$/.test(req.params.id)) return res.status(404).type('text').send('Not found');
    const m = await store.getMedia(req.params.id);
    if (!m) return res.status(404).type('text').send('Not found');
    res.set({
      'Content-Type': m.mime,
      'Cache-Control': 'public, max-age=31536000, s-maxage=31536000, immutable',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Content-Disposition': 'inline',
    }).send(m.bytes);
  }));

  app.use('/api', (req, res) => res.status(404).json({ ok: false }));

  /* ───────────── the public site, when this server is also the web server (not on Vercel: its CDN serves dist/) ───────────── */
  const hasDist = existsSync(dist);
  if (hasDist) {
    let indexCache = null;                         // { stamp, html }
    const renderIndex = ({ content, meta }) => {
      const stamp = meta.updatedAt;                  // changes whenever the content is saved
      if (indexCache && indexCache.stamp === stamp) return indexCache.html;
      // visitors get publicContent(): drafts and un-featured concepts are removed on the server, so they never reach the browser
      const safeJson = JSON.stringify(publicContent(content)).replace(/</g, `${String.fromCharCode(92)}u003c`);   // can't break out of the <script>
      const withContent = readFileSync(resolve(dist, 'index.html'), 'utf8')
        .replace('<!--SITE_CONTENT-->', `<script type="application/json" id="site-content">${safeJson}</script>`);
      // same injectSeo() the Phase-1 SEO analyzer runs against, so what it checks and what a visitor gets can never drift apart
      // (it reads only content.seo, content.lab and content.contact, never the portfolio items, so passing the full content leaks no draft)
      const html = injectSeo(withContent, content, process.env.PUBLIC_URL);
      indexCache = { stamp, html };
      return html;
    };
    // dist/index.html is the raw build template (default metadata, unfilled content marker); the rendered page is `/`. Express answers HEAD through this GET route.
    // A temporary (302) redirect for now; it must come before express.static, which would otherwise serve the template file at this path.
    app.get('/index.html', (req, res) => res.redirect(302, '/'));
    app.use(express.static(dist, {
      index: false,
      setHeaders: (res, file) => res.set('Cache-Control', /[\\/]assets[\\/](?!projects[\\/])/.test(file) ? 'public, max-age=31536000, immutable' : 'public, max-age=3600'),
    }));
    app.get('/', asyncH(async (req, res) => {
      const s = await site();
      res.set('Cache-Control', 'no-cache').type('html').send(renderIndex(s));
    }));
  }
  app.use((req, res) => res.status(404).type('text').send('Not found'));
  app.use((err, req, res, next) => {                              // bad JSON, oversize body…
    if (res.headersSent) return next(err);
    if (err.type === 'entity.too.large') return res.status(413).json({ ok: false, error: 'That file is too large. Photos can be up to 1.5 MB (they are shrunk automatically when you upload them here).' });
    if (!err.status || err.status >= 500) console.error('[server]', err);
    res.status(err.status && err.status < 500 ? err.status : 500).json({ ok: false, error: err.status && err.status < 500 ? 'Bad request.' : 'Something went wrong.' });
  });

  await site();                                    // seeds the default content on first ever start
  return { app, store, mailer, hasDist };
}
