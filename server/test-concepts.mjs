// Selected Concepts managed from the admin: validation, draft / featured visibility, order, delete, the screenshot preview, auth.
// Runs the real app on a temporary SQLite database.   Run: node server/test-concepts.mjs   (the HTML check needs `npm run build` first)
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

const DB = join(tmpdir(), 'hk-concepts-test.db');
for (const s of ['', '-wal', '-shm']) rmSync(DB + s, { force: true });
Object.assign(process.env, { SQLITE_PATH: DB, SMTP_HOST: '', SETUP_TOKEN: '', GOOGLE_CLIENT_ID: '', NODE_ENV: 'development', CONTENT_TTL_MS: '100' });
delete process.env.DATABASE_URL;

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { (cond ? pass++ : fail++); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };
const { createApp } = await import(new URL('./app.js', import.meta.url).href);
const { previewPath } = await import(new URL('../content/schema.js', import.meta.url).href);
const { app, store, hasDist } = await createApp();
const server = await new Promise((r) => { const s = app.listen(8832, () => r(s)); });
const base = 'http://localhost:8832';

let cookie = '';
async function call(method, path, { json, raw, type, auth = true } = {}) {
  const h = { 'X-Requested-With': 'hk-admin' };
  if (json !== undefined) h['Content-Type'] = 'application/json';
  if (raw !== undefined) h['Content-Type'] = type;
  if (auth && cookie) h.Cookie = cookie;
  const res = await fetch(base + path, { method, headers: h, body: json !== undefined ? JSON.stringify(json) : raw });
  for (const c of res.headers.getSetCookie?.() || []) { const [kv] = c.split(';'); const [k, v] = kv.split('='); cookie = v === '' ? '' : `${k}=${v}`; }
  const buf = Buffer.from(await res.arrayBuffer());
  let data = {}; try { data = JSON.parse(buf.toString()); } catch { /* not JSON */ }
  return { status: res.status, data, text: buf.toString(), buf, headers: res.headers };
}
const publicNames = async () => (await call('GET', '/api/content', { auth: false })).data.work.items.map((i) => i.name);
const adminDoc = async () => (await call('GET', '/api/admin/content')).data.content;
// a save must carry the content version it is based on (the server refuses a missing or out-of-date one); read the current version right before each save
const save = async (doc) => { const cur = await call('GET', '/api/admin/content'); return call('PUT', '/api/admin/content', { json: { content: doc, version: cur.data.version } }); };
const project = (o = {}) => ({ name: 'Test One', meta: 'Website · Test', featured: true, published: true, kind: 'live', description: 'A test project.', technologies: ['React', 'Node.js'], liveUrl: 'https://one.example.com/', githubUrl: '', ...o });

/* ───── signed out: public content works, the admin API does not ───── */
let r = await call('GET', '/api/content', { auth: false });
ok('public content loads without signing in', r.status === 200 && Array.isArray(r.data.work?.items));
ok('admin content is refused without signing in (401)', (await call('GET', '/api/admin/content', { auth: false })).status === 401);
ok('saving content is refused without signing in (401)', (await call('PUT', '/api/admin/content', { json: { content: {} }, auth: false })).status === 401);
r = await call('POST', '/api/auth/setup', { json: { name: 'Test Admin', email: 'concepts-test@example.com', password: 'a-long-test-password-1' } });
ok('test admin created', r.status === 201, JSON.stringify(r.data));

/* ───── validation ───── */
let doc = await adminDoc();
const seeded = doc.work.items.length;
ok('the seeded work is the real client project (ITS4U Mobiles), live, linked to its case study page', seeded === 1 && doc.work.items.every((i) => i.kind === 'live' && /^https:\/\//.test(i.liveUrl)) && doc.work.items[0].caseUrl === '/work/its4u-mobiles');
const bad = async (label, patch, path) => { const d = structuredClone(doc); d.work.items.push(project(patch)); const x = await save(d); ok(label, x.status === 400 && x.data.errors.some((e) => e.path.includes(path)), `${x.status} ${JSON.stringify(x.data.errors)}`); };
await bad('a project without a name is refused', { name: '' }, 'name');
await bad('a project without a live URL is refused', { liveUrl: '' }, 'liveUrl');
await bad('a javascript: live URL is refused', { liveUrl: 'javascript:alert(1)' }, 'liveUrl');
await bad('a live URL with spaces is refused', { liveUrl: 'https://exa mple.com' }, 'liveUrl');
await bad('a live URL with no host is refused', { liveUrl: 'https://' }, 'liveUrl');
await bad('a live URL with embedded login is refused', { liveUrl: 'https://user:pw@example.com/' }, 'liveUrl');
await bad('a relative live URL is refused', { liveUrl: '/just-a-path' }, 'liveUrl');
await bad('a bad GitHub URL is refused', { githubUrl: 'not a url' }, 'githubUrl');
await bad('a project without a description is refused', { description: '' }, 'description');
await bad('more than 8 technologies is refused', { technologies: Array.from({ length: 9 }, (_, i) => `T${i}`) }, 'technologies');

/* ───── create ───── */
doc = await adminDoc();
doc.work.items.push(project());
r = await save(doc);
ok('a new project saves', r.status === 200 && r.data.ok, JSON.stringify(r.data));
ok('…and appears on the public site, last', (await publicNames()).at(-1) === 'Test One');
const pub = (await call('GET', '/api/content', { auth: false })).data.work.items.at(-1);
ok('…with its description, category, technologies and live URL', pub.description === 'A test project.' && pub.meta === 'Website · Test' && pub.technologies.join() === 'React,Node.js' && pub.liveUrl === 'https://one.example.com/');

/* ───── edit ───── */
doc = await adminDoc();
Object.assign(doc.work.items.at(-1), { name: 'Test Renamed', description: 'Changed text.', liveUrl: 'https://two.example.com/path?x=1', githubUrl: 'https://github.com/example/repo' });
r = await save(doc);
const edited = (await call('GET', '/api/content', { auth: false })).data.work.items.at(-1);
ok('an edit is visible on the public site', r.status === 200 && edited.name === 'Test Renamed' && edited.description === 'Changed text.');
ok('the live URL change is what the "View live" button will use', edited.liveUrl === 'https://two.example.com/path?x=1' && edited.githubUrl === 'https://github.com/example/repo');

/* ───── preview: a screenshot whose address is worked out from the Live URL (nothing is uploaded or typed) ───── */
const shotOf = async () => (await call('GET', '/api/content', { auth: false })).data.work.items.at(-1).preview;
ok('the public content gives a live project the screenshot address worked out from its Live URL', await shotOf() === '/assets/projects/two-example-com-path-preview.webp', await shotOf());
doc = await adminDoc(); doc.work.items.at(-1).preview = 'https://evil.example/x.png'; r = await save(doc);
ok('a preview typed into the content is not trusted: it is dropped on save and the derived address is served', r.status === 200 && r.data.content.work.items.at(-1).preview === undefined && await shotOf() === '/assets/projects/two-example-com-path-preview.webp');
doc = await adminDoc(); doc.work.items.at(-1).liveUrl = 'https://Other-Site.example.com/'; await save(doc);
ok('changing the Live URL changes the screenshot the card asks for', await shotOf() === '/assets/projects/other-site-example-com-preview.webp', await shotOf());
ok('the address is the same one the admin and the capture script use (previewPath)', previewPath('https://other-site.example.com/') === '/assets/projects/other-site-example-com-preview.webp' && previewPath('https://www.Example.com') === '/assets/projects/example-com-preview.webp' && previewPath('https://example.com/a/b/') === '/assets/projects/example-com-a-b-preview.webp' && previewPath('not a url') === '' && /^\/assets\/projects\/[a-z0-9-]+-preview\.webp$/.test(previewPath('https://x.example/' + 'a'.repeat(300))));
ok('two different projects never share a screenshot file', previewPath('https://a.example.com/') !== previewPath('https://b.example.com/') && previewPath('https://example.com/a') !== previewPath('https://example.com/b'));

/* ───── featured / published ───── */
const flip = async (patch) => { const d = await adminDoc(); Object.assign(d.work.items.at(-1), patch); return save(d); };
await flip({ featured: false });
ok('Featured OFF → gone from the public site', !(await publicNames()).includes('Test Renamed'));
ok('…but still in the admin', (await adminDoc()).work.items.some((i) => i.name === 'Test Renamed'));
await flip({ featured: true });
ok('Featured ON → back on the public site', (await publicNames()).includes('Test Renamed'));
await flip({ published: false });
ok('a draft is not on the public site', !(await publicNames()).includes('Test Renamed'));
ok('…its URL is not leaked in the public content either', !JSON.stringify((await call('GET', '/api/content', { auth: false })).data).includes('two.example.com'));
ok('…and it is still editable in the admin', (await adminDoc()).work.items.some((i) => i.name === 'Test Renamed' && i.published === false));
if (hasDist) {
  const html = (await call('GET', '/', { auth: false })).text;
  ok('a draft is not in the page HTML either', !html.includes('Test Renamed') && !html.includes('two.example.com'));
}
await flip({ published: true });
ok('published again → visible', (await publicNames()).includes('Test Renamed'));
if (hasDist) ok('…and in the page HTML', (await call('GET', '/', { auth: false })).text.includes('Test Renamed'));

/* ───── order ───── */
doc = await adminDoc();
const before = doc.work.items.map((i) => i.name);
const [moved] = doc.work.items.splice(doc.work.items.length - 1, 1); doc.work.items.unshift(moved);
await save(doc);
const after = await publicNames();
ok('moving a project first puts it first on the public site', after[0] === 'Test Renamed' && after.slice(1).join() === before.slice(0, -1).join(), after.join());

/* ───── old content keeps working ───── */
await store.saveContent({ ...(await adminDoc()), work: { eyebrow: 'x', title: 'y', note: '', items: [{ name: 'Old sample', meta: 'Website', url: 'old.example', kind: 'hero', a: '#112233', b: '#445566', title: 'Hi', sub: '', cta: '', nav: [], kpis: [], bars: [], chat: [] }] } }, 'test', 'old shape');
await new Promise((r2) => setTimeout(r2, 300));
ok('a concept saved before the new flags existed still shows publicly', (await publicNames()).join() === 'Old sample');
doc = await adminDoc();
r = await save(doc);
ok('…and still saves, defaulting to published + featured', r.status === 200 && r.data.content.work.items[0].published === true && r.data.content.work.items[0].featured === true, JSON.stringify(r.data.errors || r.data.content.work.items[0]));

/* ───── delete ───── */
doc = await adminDoc(); doc.work.items.push(project({ name: 'To delete' })); await save(doc);
ok('a project to delete is on the site', (await publicNames()).includes('To delete'));
doc = await adminDoc(); doc.work.items = doc.work.items.filter((i) => i.name !== 'To delete'); r = await save(doc);
ok('after deleting, it is gone from the public site and the admin', r.status === 200 && !(await publicNames()).includes('To delete') && !(await adminDoc()).work.items.some((i) => i.name === 'To delete'));
doc = await adminDoc(); doc.work.items = []; r = await save(doc);
ok('every concept can be removed (the section then hides)', r.status === 200 && (await publicNames()).length === 0);

/* ═════════ the Live URL: normalising ═════════ */
const saveUrl = async (typed) => { doc = await adminDoc(); doc.work.items = [project({ name: 'URL test', liveUrl: typed })]; const x = await save(doc); return x.status === 200 ? x.data.content.work.items[0].liveUrl : `refused:${x.data.errors?.[0]?.path}`; };
ok('"Example.COM/Path#top" is saved as https://example.com/Path', await saveUrl('Example.COM/Path#top') === 'https://example.com/Path');
ok('a typed https:// address is kept, host lower-cased', await saveUrl('HTTPS://Project-A.Vercel.App') === 'https://project-a.vercel.app/');
ok('the default port is dropped', await saveUrl('https://example.com:443/x') === 'https://example.com/x');
ok('javascript: is refused', (await saveUrl('javascript:alert(1)')).startsWith('refused:'));
ok('data: is refused', (await saveUrl('data:text/html,<script>alert(1)</script>')).startsWith('refused:'));
ok('ftp: is refused', (await saveUrl('ftp://example.com/')).startsWith('refused:'));

/* ═════════ content saved BEFORE screenshots existed (it carries an uploaded photo and the old iframe fields): nothing to migrate ═════════ */
const olderDoc = await adminDoc();
const legacy = { name: 'Legacy live', meta: 'Website', featured: true, published: true, kind: 'live', description: 'Saved earlier.', technologies: [], liveUrl: 'https://legacy.example.com/', githubUrl: '', preview: '/media/' + 'a'.repeat(32), embed: 'ok', embedUrl: 'https://legacy.example.com/', embedCheckedAt: '2026-01-01T00:00:00.000Z' };
await store.saveContent({ ...olderDoc, work: { ...olderDoc.work, items: [legacy, { ...legacy, name: 'Legacy draft', liveUrl: 'https://draft.example.com/', published: false }] } }, 'test', 'content as an older version saved it');
await new Promise((r2) => setTimeout(r2, 300));
const old = (await call('GET', '/api/content', { auth: false })).data.work.items;
ok('legacy: an old uploaded preview is replaced by the derived screenshot address (no old screenshot is ever shown)', old.length === 1 && old[0].preview === '/assets/projects/legacy-example-com-preview.webp', JSON.stringify(old));
doc = await adminDoc(); r = await save(doc);
ok('legacy: it still saves, and the stored data no longer carries an uploaded preview or iframe fields', r.status === 200 && r.data.content.work.items[0].preview === undefined && r.data.content.work.items[0].embed === undefined, JSON.stringify(r.data.errors || r.data.content.work.items[0]));

/* ═════════ no iframes, anywhere ═════════ */
const hdr = (h2) => String(h2.get('content-security-policy') || '');
ok('API responses allow no frames at all', hdr((await call('GET', '/api/content', { auth: false })).headers).includes("frame-src 'none';"));
ok('the admin portal allows no frames either (it only shows a picture)', hdr((await call('GET', '/admin', { auth: false })).headers).includes("frame-src 'none';"));
ok('there is no Live-URL "embeddable?" check endpoint any more', (await call('POST', '/api/admin/preview-check', { json: { url: 'https://example.com/' } })).status === 404);
const { readFile } = await import('node:fs/promises');
ok("the website's and the admin's source have no iframe in them", !/iframe/i.test(await readFile(new URL('../src/modules/work.js', import.meta.url), 'utf8')) && !/iframe/i.test(await readFile(new URL('./admin/admin.js', import.meta.url), 'utf8')));
if (hasDist) {
  const page = await call('GET', '/', { auth: false });
  ok('the page itself allows no frames and cannot be embedded elsewhere', hdr(page.headers).includes("frame-src 'none';") && hdr(page.headers).includes("frame-ancestors 'none'"));
  ok('the page HTML carries the screenshot address of the shown project (and nothing of the draft)', page.text.includes('/assets/projects/legacy-example-com-preview.webp') && !page.text.includes('draft.example.com'));
  const img = await call('GET', '/assets/projects/its4u-vercel-app-preview.webp', { auth: false });
  ok('a shipped screenshot is served as an image', img.status === 200 && /image\/webp/.test(img.headers.get('content-type')) && img.buf.subarray(0, 4).toString('latin1') === 'RIFF', `${img.status} ${img.headers.get('content-type')}`);
  ok('…and is NOT cached as immutable (a re-captured screenshot at the same address must reach visitors)', !/immutable/.test(img.headers.get('cache-control') || ''), img.headers.get('cache-control'));
  ok('a screenshot that does not exist is a plain 404 (the card then keeps its name card)', (await call('GET', '/assets/projects/nothing-here-preview.webp', { auth: false })).status === 404);
}

server.close(); await store.close();
for (const s of ['', '-wal', '-shm']) rmSync(DB + s, { force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
