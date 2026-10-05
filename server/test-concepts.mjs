// Selected Concepts managed from the admin: validation, draft / featured visibility, order, delete, preview, auth.
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
  return { status: res.status, data, text: buf.toString(), buf };
}
const publicNames = async () => (await call('GET', '/api/content', { auth: false })).data.work.items.map((i) => i.name);
const adminDoc = async () => (await call('GET', '/api/admin/content')).data.content;
const save = async (doc) => call('PUT', '/api/admin/content', { json: { content: doc } });
const project = (o = {}) => ({ name: 'Test One', meta: 'Website · Test', featured: true, published: true, kind: 'live', description: 'A test project.', technologies: ['React', 'Node.js'], liveUrl: 'https://one.example.com/', githubUrl: '', preview: '', ...o });

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
ok('the seeded concepts are the two real projects, both live', seeded === 2 && doc.work.items.every((i) => i.kind === 'live' && /^https:\/\//.test(i.liveUrl)));
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
await bad('an outside image address as preview is refused', { preview: 'https://evil.example/x.png' }, 'preview');
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

/* ───── preview: upload, set, replace, remove ───── */
const WEBP = (n) => Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.from([0x40, 0, 0, 0]), Buffer.from('WEBPVP8 ', 'latin1'), Buffer.alloc(80, n)]);
const up1 = await call('POST', '/api/admin/media', { raw: WEBP(1), type: 'image/webp' });
const up2 = await call('POST', '/api/admin/media', { raw: WEBP(2), type: 'image/webp' });
ok('two preview images upload', up1.status === 201 && up2.status === 201 && up1.data.url !== up2.data.url);
doc = await adminDoc(); doc.work.items.at(-1).preview = up1.data.url; r = await save(doc);
ok('a preview can be set', r.status === 200 && (await call('GET', '/api/content', { auth: false })).data.work.items.at(-1).preview === up1.data.url);
ok('…and the public site can load it', (await call('GET', up1.data.url, { auth: false })).status === 200);
doc = await adminDoc(); doc.work.items.at(-1).preview = up2.data.url; await save(doc);
ok('a preview can be replaced', (await call('GET', '/api/content', { auth: false })).data.work.items.at(-1).preview === up2.data.url);
doc = await adminDoc(); doc.work.items.at(-1).preview = ''; r = await save(doc);
ok('a preview can be removed', r.status === 200 && (await call('GET', '/api/content', { auth: false })).data.work.items.at(-1).preview === '');
doc = await adminDoc(); doc.work.items.at(-1).preview = '/work/its4u.webp'; r = await save(doc);
ok('a screenshot shipped in /work/ is accepted too', r.status === 200);

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

server.close(); await store.close();
for (const s of ['', '-wal', '-shm']) rmSync(DB + s, { force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
