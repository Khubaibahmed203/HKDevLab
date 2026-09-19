import express from 'express';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore, STATUSES } from './db.js';
import { createMailer } from './mail.js';
import { validateEnquiry } from './validate.js';
import { createAuth } from './auth.js';
import { createGoogle, googleEnabled } from './google.js';
import { DEFAULT_CONTENT, sanitizeContent, withDefaults } from './content.js';

try { process.loadEnvFile(); } catch { /* no .env file — real env vars only */ }

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');
// --port=… wins (used by `npm run dev` so the API never collides with Vite); hosts like Render set PORT
const argPort = process.argv.find((a) => a.startsWith('--port='))?.slice(7);
const PORT = +argPort || +process.env.PORT || 8788;
const IS_PROD = process.env.NODE_ENV === 'production';
const HASH_SALT = process.env.IP_HASH_SALT || 'hkdevlab';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);

let store;
try { store = await createStore(); } catch (e) {
  // never echo DATABASE_URL itself — it contains the password
  console.error(`\nCould not open the database: ${e.code || e.message}\n${process.env.DATABASE_URL
    ? 'Check DATABASE_URL (the full postgres://… connection string from Neon/Render, copied exactly).'
    : 'Check SQLITE_PATH and that the folder is writable.'}\n`);
  process.exit(1);
}
const mailer = createMailer();
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);                      // correct client IP behind Render / Vercel / nginx

/* ───────────── content (kept in memory, persisted in the database) ───────────── */
let content, contentMeta;
async function loadContent() {
  const row = await store.getContent();
  if (!row) { await store.saveContent(DEFAULT_CONTENT, 'system', 'Initial content'); content = DEFAULT_CONTENT; contentMeta = {}; return; }
  content = withDefaults(row.data); contentMeta = { updatedAt: row.updatedAt, updatedBy: row.updatedBy };
}
await loadContent();

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
const hashIp = (ip) => createHash('sha256').update(`${HASH_SALT}:${ip}`).digest('hex').slice(0, 24);   // no raw IPs stored

const hits = new Map();                         // key → timestamps (in-memory; fine for a single instance)
function rateLimited(key, max, windowMs) {
  const now = Date.now();
  const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (recent.length >= max) { hits.set(key, recent); return true; }
  recent.push(now); hits.set(key, recent);
  return false;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some((t) => now - t < 3_600_000)) hits.delete(k); }, 600_000).unref();

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

const auth = createAuth(store, { isProd: IS_PROD, originAllowed, hashIp });
const { asyncH } = auth;
const google = createGoogle(store, auth, { isProd: IS_PROD, hashIp });

/* ───────────── health + public content ───────────── */
app.get('/api/health', async (req, res) => {
  try { await store.ping(); res.json({ ok: true, db: store.kind, mail: mailer.live ? 'smtp' : 'console (SMTP not configured)' }); }
  catch { res.status(503).json({ ok: false }); }
});
app.get('/api/content', (req, res) => res.set('Cache-Control', 'no-cache').json(content));

/* ───────────── contact form ───────────── */
app.post('/api/contact', express.json({ limit: '20kb' }), async (req, res) => {
  if (!originAllowed(req)) return res.status(403).json({ ok: false, error: 'Forbidden.' });

  const ipHash = hashIp(req.ip);
  if (rateLimited(`c:${ipHash}`, 5, 15 * 60_000)) {
    return res.status(429).json({ ok: false, error: 'Too many messages from your connection. Please try again in a few minutes, or email us directly.' });
  }

  // Bots: a filled honeypot or a form "submitted" faster than a human can type. Pretend success, store nothing.
  const elapsed = Number(req.body?.elapsed);
  if (req.body?.website || (Number.isFinite(elapsed) && elapsed < 2500)) return res.status(201).json({ ok: true });

  const { errors, value } = validateEnquiry(req.body, content.contact.formTypes);
  if (errors) return res.status(400).json({ ok: false, errors });

  try {
    const id = await store.insert({ ...value, ipHash, userAgent: String(req.get('user-agent') || '').slice(0, 300) });
    res.status(201).json({ ok: true, id });                     // answer as soon as it's safely stored…
    mailer.sendEnquiry({ id, ...value })                         // …email in the background
      .then((sent) => store.setEmailed(id, sent))
      .catch((err) => console.error('[mail] unexpected:', err));
  } catch (err) {
    console.error('[contact] store failed:', err);
    res.status(500).json({ ok: false, error: `Something went wrong on our side. Please email us at ${mailer.to}.` });
  }
});

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

// site content (admins and editors)
admin.get('/content', (req, res) => res.json({ content, ...contentMeta }));
admin.put('/content', asyncH(async (req, res) => {
  const { errors, value } = sanitizeContent(req.body?.content);
  if (errors) return res.status(400).json({ ok: false, errors });
  const at = await store.saveContent(value, req.user.email, String(req.body?.note ?? '').slice(0, 120));
  content = value; contentMeta = { updatedAt: at, updatedBy: req.user.email }; indexCache = null;
  res.json({ ok: true, content, ...contentMeta });
}));
admin.get('/content/versions', asyncH(async (req, res) => res.json({ versions: await store.listVersions() })));
admin.post('/content/restore/:id', asyncH(async (req, res) => {
  const old = await store.getVersion(+req.params.id);
  if (!old) return res.status(404).json({ ok: false, error: 'Version not found.' });
  const { errors, value } = sanitizeContent(withDefaults(old));
  if (errors) return res.status(422).json({ ok: false, errors });
  const at = await store.saveContent(value, req.user.email, `Restored version #${req.params.id}`);
  content = value; contentMeta = { updatedAt: at, updatedBy: req.user.email }; indexCache = null;
  res.json({ ok: true, content, ...contentMeta });
}));
app.use('/api/admin', admin);

/* ───────────── the admin portal (static UI; every action behind the API above) ───────────── */
app.use('/admin', (req, res, next) => { res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' }); next(); });
app.get('/admin/schema.js', (req, res) => res.type('js').sendFile(resolve(root, 'content/schema.js')));
app.get(['/admin', '/admin/'], (req, res) => res.sendFile(resolve(root, 'server/admin/index.html')));
app.use('/admin', express.static(resolve(root, 'server/admin'), { index: false }));

/* ───────────── the site (HTML gets the live content + SEO tags injected) ───────────── */
app.use('/api', (req, res) => res.status(404).json({ ok: false }));

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let indexCache = null;
function renderIndex() {
  if (indexCache) return indexCache;
  const safeJson = JSON.stringify(content).replace(/</g, `${String.fromCharCode(92)}u003c`);   // can't break out of the <script>
  indexCache = readFileSync(resolve(dist, 'index.html'), 'utf8')
    .replace('<!--SITE_CONTENT-->', `<script type="application/json" id="site-content">${safeJson}</script>`)
    .replace(/<title>[\s\S]*?<\/title>/, () => `<title>${esc(content.seo.title)}</title>`)
    .replace(/(<meta name="description" content=")[^"]*(")/, (m, a, b) => `${a}${esc(content.seo.description)}${b}`)
    .replace(/(<meta property="og:title" content=")[^"]*(")/, (m, a, b) => `${a}${esc(content.seo.title)}${b}`)
    .replace(/(<meta property="og:description" content=")[^"]*(")/, (m, a, b) => `${a}${esc(content.seo.description)}${b}`);
  return indexCache;
}

if (existsSync(dist)) {
  app.use(express.static(dist, {
    index: false,
    setHeaders: (res, file) => res.set('Cache-Control', /[\\/]assets[\\/]/.test(file) ? 'public, max-age=31536000, immutable' : 'public, max-age=3600'),
  }));
  app.get('/', (req, res) => res.set('Cache-Control', 'no-cache').type('html').send(renderIndex()));
}
app.use((req, res) => res.status(404).type('text').send('Not found'));
app.use((err, req, res, next) => {                              // bad JSON, oversize body…
  if (res.headersSent) return next(err);
  if (!err.status || err.status >= 500) console.error('[server]', err);
  res.status(err.status && err.status < 500 ? err.status : 500).json({ ok: false, error: err.status && err.status < 500 ? 'Bad request.' : 'Something went wrong.' });
});

const server = app.listen(PORT, async () => {
  console.log(`HK DevLab server → http://localhost:${PORT}`);
  console.log(`  database: ${store.kind}`);
  console.log(`  email:    ${mailer.live ? `SMTP → ${mailer.to}` : 'console only (set SMTP_HOST to send real email)'}`);
  console.log(`  google:   ${googleEnabled() ? 'sign-in enabled' : 'not configured (set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)'}`);
  console.log(`  admin:    /admin ${(await store.userCount()) === 0 ? '— NO ACCOUNTS YET: the first person to finish setup becomes admin' : 'ready'}`);
  if ((await store.userCount()) === 0 && IS_PROD && !process.env.SETUP_TOKEN) console.warn('  ⚠ set SETUP_TOKEN so only you can claim the admin account, or finish setup right after deploying');
  if (!existsSync(dist)) console.log('  site:     dist/ not built — run `npm run build` (API only for now)');
});
mailer.verify().then(() => mailer.live && console.log('  smtp:     connection verified')).catch((e) => console.error('  smtp:     VERIFY FAILED —', e.message));

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => store.close().finally(() => process.exit(0))));
