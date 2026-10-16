// /index.html is the raw build template (default metadata, unfilled content marker); on the Node/Render server it redirects to the rendered page at `/`.
// Starts the real app (createApp) on a loopback port with a TEMPORARY SQLite file, never DATABASE_URL, and uses the repo's existing built dist/ read-only:
// it never creates, overwrites or deletes dist/. The redirect is only registered when dist/ exists (Vercel's CDN serves dist/ itself), so without a build the
// redirect checks are reported as SKIPPED — never as passed — and only the checks that hold without dist/ are counted.
// Run: node server/test-index-redirect.mjs
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DB = join(tmpdir(), 'hk-index-redirect-test.db');
for (const s of ['', '-wal', '-shm']) rmSync(DB + s, { force: true });
Object.assign(process.env, { SQLITE_PATH: DB, SMTP_HOST: '', SETUP_TOKEN: '', GOOGLE_CLIENT_ID: '', NODE_ENV: 'development' });
delete process.env.DATABASE_URL;

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { (cond ? pass++ : fail++); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };
const skip = (name, why) => console.log(`SKIP  ${name}  (${why})`);

const { createApp } = await import(new URL('./app.js', import.meta.url).href);
const ctx = await createApp();
const server = await new Promise((r) => { const s = ctx.app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
const get = async (path, init = {}) => { const res = await fetch(base + path, { redirect: 'manual', ...init }); return { res, status: res.status, location: res.headers.get('location'), text: await res.text() }; };

ok('the app reports whether it serves the built site (hasDist) consistently with dist/index.html existing', ctx.hasDist === existsSync(join(ROOT, 'dist', 'index.html')));

/* checks that hold with or without a built dist/ */
let r = await get('/api/health');
ok('/api/health is unchanged: 200 JSON, ok, adapter name only', r.status === 200 && r.location === null && JSON.parse(r.text).ok === true && JSON.parse(r.text).db === 'sqlite', `${r.status} ${r.text.slice(0, 120)}`);
const admin = await get('/admin');
ok('/admin is unchanged: 200 HTML, not a redirect, never cached', admin.status === 200 && admin.location === null && /text\/html/i.test(admin.res.headers.get('content-type') || '') && /no-store/.test(admin.res.headers.get('cache-control') || ''), `${admin.status} ${admin.location}`);
const adminIndex = await get('/admin/index.html');
ok('/admin/index.html is unchanged: 200 HTML (the admin static file), not a redirect, same page as /admin', adminIndex.status === 200 && adminIndex.location === null && /text\/html/i.test(adminIndex.res.headers.get('content-type') || '') && adminIndex.text === admin.text, `${adminIndex.status} ${adminIndex.location}`);

if (!ctx.hasDist) {
  r = await get('/index.html');
  ok('without a built dist/ nothing serves /index.html (404, as before) — the redirect is registered only together with the site', r.status === 404 && r.location === null, String(r.status));
  skip('GET /index.html → 302 to /', 'no dist/ — run `npm run build` first');
  skip('HEAD /index.html → 302 to /, empty body', 'no dist/');
  skip('GET /index.html?x=1 → 302 to /', 'no dist/');
  skip('GET / renders HTML without the SITE_CONTENT marker', 'no dist/');
  skip('a static asset is still served', 'no dist/');
} else {
  const template = readFileSync(join(ROOT, 'dist', 'index.html'), 'utf8');
  ok('precondition: the built dist/index.html still carries the content marker (otherwise "no marker in the rendered page" would prove nothing)', template.includes('<!--SITE_CONTENT-->'), 'rebuild dist/ with `npm run build`');

  r = await get('/index.html');
  ok('GET /index.html → 302 with Location: / (not followed)', r.status === 302 && r.location === '/', `${r.status} ${r.location}`);
  ok('…and the redirect response does not carry the template', !r.text.includes('<!--SITE_CONTENT-->') && !/<title>/i.test(r.text));

  r = await get('/index.html', { method: 'HEAD' });
  ok('HEAD /index.html → 302 with Location: / and an empty body (answered by the GET route)', r.status === 302 && r.location === '/' && r.text === '', `${r.status} ${r.location} body=${JSON.stringify(r.text.slice(0, 40))}`);

  r = await get('/index.html?x=1');
  ok('GET /index.html?x=1 → 302 with Location: /', r.status === 302 && r.location === '/', `${r.status} ${r.location}`);

  r = await get('/');
  ok('GET / → 200 HTML, not a redirect', r.status === 200 && r.location === null && /text\/html/i.test(r.res.headers.get('content-type') || ''), `${r.status} ${r.location}`);
  ok('…the rendered HTML has no SITE_CONTENT marker, and carries the embedded site content instead', !/SITE_CONTENT/.test(r.text) && r.text.includes('<script type="application/json" id="site-content">'));
  ok('…and it is not the raw template', r.text !== template);

  const assets = existsSync(join(ROOT, 'dist', 'assets')) ? readdirSync(join(ROOT, 'dist', 'assets')).filter((f) => /\.(js|css)$/.test(f)) : [];
  if (assets.length) {
    const a = await get(`/assets/${assets[0]}`);
    ok('a built static asset is still served by express.static (200, long-lived cache, not a redirect)', a.status === 200 && a.location === null && /immutable/.test(a.res.headers.get('cache-control') || ''), `${a.status} ${a.res.headers.get('cache-control')}`);
  } else skip('a static asset is still served', 'no built asset found in dist/assets');
}

server.close();
await ctx.store.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.on('exit', () => { for (const s of ['', '-wal', '-shm']) { try { rmSync(DB + s, { force: true }); } catch { /* temp file, harmless */ } } });
setTimeout(() => process.exit(fail ? 1 : 0), 300);
