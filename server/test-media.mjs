// Photo uploads (founders portraits): storage, the upload endpoint's checks, public serving, and the content field.
// Runs the real app on a temporary SQLite database.   Run: node server/test-media.mjs
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { createHash } from 'node:crypto';

const DB = join(tmpdir(), 'hk-media-test.db');
for (const s of ['', '-wal', '-shm']) rmSync(DB + s, { force: true });
Object.assign(process.env, { SQLITE_PATH: DB, SMTP_HOST: '', SETUP_TOKEN: '', GOOGLE_CLIENT_ID: '', NODE_ENV: 'development', CONTENT_TTL_MS: '100' });
delete process.env.DATABASE_URL;

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { (cond ? pass++ : fail++); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };
const { createApp } = await import(new URL('./app.js', import.meta.url).href);
const { app, store } = await createApp();
const server = await new Promise((r) => { const s = app.listen(8831, () => r(s)); });
const base = 'http://localhost:8831';

let cookie = '';
async function call(method, path, { json, raw, type, headers = {}, auth = true } = {}) {
  const h = { 'X-Requested-With': 'hk-admin', ...headers };
  if (json !== undefined) h['Content-Type'] = 'application/json';
  if (raw !== undefined) h['Content-Type'] = type;
  if (auth && cookie) h.Cookie = cookie;
  const res = await fetch(base + path, { method, headers: h, body: json !== undefined ? JSON.stringify(json) : raw });
  for (const c of res.headers.getSetCookie?.() || []) { const [kv] = c.split(';'); const [k, v] = kv.split('='); cookie = v === '' ? '' : `${k}=${v}`; }
  const buf = Buffer.from(await res.arrayBuffer());
  let data = {}; try { data = JSON.parse(buf.toString()); } catch { /* not JSON */ }
  return { status: res.status, data, buf, headers: res.headers };
}

// tiny but real files (correct magic bytes)
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1'), Buffer.alloc(200, 7), Buffer.from([0xff, 0xd9])]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(120, 3)]);
const WEBP = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.from([0x40, 0, 0, 0]), Buffer.from('WEBPVP8 ', 'latin1'), Buffer.alloc(80, 5)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

/* not signed in */
let r = await call('POST', '/api/admin/media', { raw: JPEG, type: 'image/jpeg', auth: false });
ok('uploading without signing in is refused (401)', r.status === 401, String(r.status));

/* sign in as the first admin */
r = await call('POST', '/api/auth/setup', { json: { name: 'Test Admin', email: 'media-test@example.com', password: 'a-long-test-password-1' } });
ok('test admin created', r.status === 201, JSON.stringify(r.data));

/* uploading */
r = await call('POST', '/api/admin/media', { raw: JPEG, type: 'image/jpeg' });
const jpgUrl = r.data.url;
ok('a JPEG uploads (201) and returns a /media/<32 hex> address', r.status === 201 && /^\/media\/[a-f0-9]{32}$/.test(jpgUrl || ''), JSON.stringify(r.data));
ok('the address is a hash of the bytes', jpgUrl === '/media/' + createHash('sha256').update(JPEG).digest('hex').slice(0, 32));
r = await call('POST', '/api/admin/media', { raw: JPEG, type: 'image/jpeg' });
ok('the same photo again gives the same address (stored once)', r.status === 201 && r.data.url === jpgUrl);
r = await call('POST', '/api/admin/media', { raw: PNG, type: 'image/png' });
ok('a PNG uploads', r.status === 201, JSON.stringify(r.data));
r = await call('POST', '/api/admin/media', { raw: WEBP, type: 'image/webp' });
ok('a WebP uploads', r.status === 201, JSON.stringify(r.data));

/* things that must be refused */
r = await call('POST', '/api/admin/media', { raw: SVG, type: 'image/svg+xml' });
ok('SVG is refused (it can carry script)', r.status === 415 || r.status === 400, String(r.status));
r = await call('POST', '/api/admin/media', { raw: SVG, type: 'image/jpeg' });
ok('an SVG that CLAIMS to be a JPEG is refused (type is read from the bytes)', r.status === 415, String(r.status));
r = await call('POST', '/api/admin/media', { raw: Buffer.from('<html><script>alert(1)</script></html>'), type: 'image/png' });
ok('HTML claiming to be a PNG is refused', r.status === 415, String(r.status));
r = await call('POST', '/api/admin/media', { raw: Buffer.alloc(1_700_000, 1), type: 'image/jpeg' });
ok('a file over 1.5 MB is refused (413) with a friendly message', r.status === 413 && /too large/i.test(r.data.error || ''), `${r.status} ${JSON.stringify(r.data)}`);
r = await call('POST', '/api/admin/media', { raw: Buffer.alloc(0), type: 'image/jpeg' });
ok('an empty upload is refused', r.status === 415 || r.status === 400, String(r.status));
r = await call('POST', '/api/admin/media', { raw: JPEG, type: 'image/jpeg', headers: { 'X-Requested-With': '' } });
ok('an upload without the anti-forgery header is refused (403)', r.status === 403, String(r.status));
r = await call('POST', '/api/admin/media', { raw: JPEG, type: 'image/jpeg', headers: { Origin: 'https://evil.example' } });
ok('an upload from another website is refused (403)', r.status === 403, String(r.status));

/* public serving */
r = await call('GET', jpgUrl, { auth: false });
ok('the photo is served publicly with the right type and the exact bytes', r.status === 200 && r.headers.get('content-type') === 'image/jpeg' && r.buf.equals(JPEG));
ok('…cached for a year, immutable', /max-age=31536000/.test(r.headers.get('cache-control') || '') && /immutable/.test(r.headers.get('cache-control') || ''));
ok('…with nosniff and a locked-down CSP for direct visits', r.headers.get('x-content-type-options') === 'nosniff' && /sandbox/.test(r.headers.get('content-security-policy') || ''));
r = await call('GET', '/media/' + 'f'.repeat(32), { auth: false });
ok('an unknown photo → 404', r.status === 404);
r = await call('GET', '/media/..%2F..%2Fetc%2Fpasswd', { auth: false });
ok('a path-traversal style address → 404', r.status === 404);
r = await call('GET', '/media/' + 'A'.repeat(32), { auth: false });
ok('an address that is not lower-case hex → 404', r.status === 404);

/* the content field */
r = await call('GET', '/api/admin/content');
ok('admin content already contains the founders placeholders', r.status === 200 && r.data.content.founders?.people?.length === 2 && r.data.content.founders.show === true);
const doc = r.data.content;
let version = r.data.version;                         // saves must carry the content version the document was loaded with
doc.founders.people[0].photo = jpgUrl;
doc.founders.people[0].name = 'Ada Example';
r = await call('PUT', '/api/admin/content', { json: { content: doc, version } });
ok('saving content with the uploaded photo works', r.status === 200 && r.data.ok, JSON.stringify(r.data).slice(0, 200));
version = r.data.version;
await new Promise((res) => setTimeout(res, 150));
r = await call('GET', '/api/content', { auth: false });
ok('the public content now points at the photo', r.data.founders.people[0].photo === jpgUrl && r.data.founders.people[0].name === 'Ada Example');
doc.founders.people[1].photo = 'https://evil.example/tracker.png';
r = await call('PUT', '/api/admin/content', { json: { content: doc, version } });
ok('a photo address that is not our own upload is rejected on save (400)', r.status === 400, String(r.status));
doc.founders.people[1].photo = '';
doc.founders.people[1].link = 'javascript:alert(1)';
r = await call('PUT', '/api/admin/content', { json: { content: doc, version } });
ok('a javascript: portfolio link is rejected on save (400)', r.status === 400, String(r.status));
doc.founders.people[1].link = 'https://example.com/portfolio';
doc.founders.show = false;
r = await call('PUT', '/api/admin/content', { json: { content: doc, version } });
ok('the section can be hidden and links are stored', r.status === 200 && r.data.content.founders.show === false && r.data.content.founders.people[1].link === 'https://example.com/portfolio');

/* an older saved document (no founders section) still loads, with the placeholders filled in */
const old = JSON.parse(JSON.stringify(doc)); delete old.founders;
await store.saveContent(old, 'test', 'simulate a pre-founders document');
await new Promise((res) => setTimeout(res, 150));
r = await call('GET', '/api/content', { auth: false });
ok('an older saved site (no founders yet) still loads and gains the placeholders', r.status === 200 && r.data.founders?.people?.length === 2 && r.data.hero.chips.length === 4);

/* storage layer directly */
const m = await store.getMedia(jpgUrl.slice(7));
ok('store.getMedia returns a Buffer with the same bytes', Buffer.isBuffer(m.bytes) && m.bytes.equals(JPEG) && m.mime === 'image/jpeg');

server.close();
await store.close();
for (const s of ['', '-wal', '-shm']) rmSync(DB + s, { force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
