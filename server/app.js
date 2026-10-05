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
import { publicContent, canEmbed } from '../content/visibility.js';
import { probeEmbed } from './probe.js';

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
export async function createApp({ probe = probeEmbed } = {}) {       // `probe` is only replaced by the tests (no real network)
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
  // frame-src is what OUR pages may put in an <iframe>: nothing external by default; the public page adds exactly the sites
  // of the projects that were checked and allow embedding, and the admin (to preview a typed address) allows any https site.
  const csp = (frameSrc = "'self'") => `default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self'; connect-src 'self'; frame-src ${frameSrc}; frame-ancestors 'none'; base-uri 'self'; form-action 'self' mailto:`;
  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': csp(),
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
  // what visitors get: drafts and un-featured concepts are removed here, on the server, so they never reach the browser
  app.get('/api/content', asyncH(async (req, res) => res.set('Cache-Control', 'no-cache').json(publicContent((await site()).content))));

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
  // The address of the site as OUR pages are served (what a site's frame-ancestors has to allow).
  const ownOrigin = (req) => (process.env.PUBLIC_URL || `${req.protocol}://${req.get('x-forwarded-host') || req.get('host')}`).replace(/\/+$/, '');

  /**
   * Decides, on the server, which live projects can be shown in an iframe — the browser cannot tell, and an editor must not be
   * trusted to say so. Re-checks only a new or changed Live URL (or a result older than a week); an unchanged one keeps its verdict.
   * A site that can't be reached is left "unknown" (it simply won't be framed) and is tried again on the next save.
   */
  async function stampEmbeds(value, req) {
    const before = new Map(((await store.getContent())?.data?.work?.items || []).filter((i) => i.liveUrl).map((i) => [i.liveUrl, i]));
    const origin = ownOrigin(req);
    const stale = [];
    for (const it of value.work.items) {
      const blank = () => Object.assign(it, { embed: '', embedUrl: '', embedCheckedAt: '' });
      if (it.kind !== 'live' || !it.liveUrl) { blank(); continue; }
      const old = before.get(it.liveUrl);
      if (old?.embed && old.embedUrl === it.liveUrl && Date.now() - Date.parse(old.embedCheckedAt) < 7 * 86_400_000) Object.assign(it, { embed: old.embed, embedUrl: old.embedUrl, embedCheckedAt: old.embedCheckedAt });
      else { blank(); stale.push(it); }
    }
    await Promise.all(stale.map(async (it) => {
      const r = await probe(it.liveUrl, { origin }).catch(() => ({ ok: false }));
      if (r.ok) Object.assign(it, { embed: r.embeddable ? 'ok' : 'blocked', embedUrl: it.liveUrl, embedCheckedAt: new Date().toISOString() });
    }));
  }

  admin.put('/content', asyncH(async (req, res) => {
    const { errors, value } = sanitizeContent(req.body?.content);
    if (errors) return res.status(400).json({ ok: false, errors });
    await stampEmbeds(value, req);
    const at = await store.saveContent(value, req.user.email, String(req.body?.note ?? '').slice(0, 120));
    remember(value, at, req.user.email);
    res.json({ ok: true, content: value, updatedAt: at, updatedBy: req.user.email });
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

  // The admin form's live preview asks this when a Live URL is typed: may the site be shown in a frame? (admins and editors only)
  admin.post('/preview-check', asyncH(async (req, res) => {
    if (await limiter.take(`p:${req.user.id}`, 60, 10 * 60_000)) return res.status(429).json({ ok: false, reason: 'rate' });
    const r = await probe(String(req.body?.url ?? '').slice(0, 400), { origin: ownOrigin(req) }).catch(() => ({ ok: false, reason: 'unreachable' }));
    res.json(r);
  }));

  admin.get('/content/versions', asyncH(async (req, res) => res.json({ versions: await store.listVersions() })));
  admin.post('/content/restore/:id', asyncH(async (req, res) => {
    const old = await store.getVersion(+req.params.id);
    if (!old) return res.status(404).json({ ok: false, error: 'Version not found.' });
    const { errors, value } = sanitizeContent(withDefaults(old));
    if (errors) return res.status(422).json({ ok: false, errors });
    await stampEmbeds(value, req);
    const at = await store.saveContent(value, req.user.email, `Restored version #${req.params.id}`);
    remember(value, at, req.user.email);
    res.json({ ok: true, content: value, updatedAt: at, updatedBy: req.user.email });
  }));
  app.use('/api/admin', admin);

  /* ───────────── the admin portal (static UI; every action behind the API above) ───────────── */
  app.use('/admin', (req, res, next) => { res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'Content-Security-Policy': csp('https:') }); next(); });
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
      if (indexCache && indexCache.stamp === meta.updatedAt) return indexCache.html;
      const safeJson = JSON.stringify(publicContent(content)).replace(/</g, `${String.fromCharCode(92)}u003c`);   // can't break out of the <script>
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
    app.get('/', asyncH(async (req, res) => {
      const s = await site();
      const origins = [...new Set(publicContent(s.content).work.items.filter(canEmbed).map((i) => new URL(i.liveUrl).origin))];   // exactly the sites we will frame
      res.set({ 'Cache-Control': 'no-cache', 'Content-Security-Policy': csp(["'self'", ...origins].join(' ')) }).type('html').send(renderIndex(s));
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
