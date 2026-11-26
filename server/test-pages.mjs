// The content pages (services, about, case studies, blog), the sitemap, llms.txt and the homepage's static copy — all built from
// content/site.js. Regenerates the pages first (scripts/generate-pages.mjs is deterministic), then checks the HTML a crawler would read.
// Run: node server/test-pages.mjs
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { (cond ? pass++ : fail++); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { BUSINESS, SERVICES, POSTS, PAGES, SUBPAGE_PATHS } = await import(new URL('../content/site.js', import.meta.url).href);
const { buildJsonLd, DEFAULT_ORIGIN, esc } = await import(new URL('../content/seo.js', import.meta.url).href);
const { DEFAULT_CONTENT, withDefaults } = await import(new URL('./content.js', import.meta.url).href);

const env = { ...process.env }; delete env.PUBLIC_URL;          // the committed sitemap/llms.txt name the production origin
const gen = spawnSync(process.execPath, ['scripts/generate-pages.mjs'], { cwd: root, env, encoding: 'utf8' });
ok('scripts/generate-pages.mjs runs cleanly', gen.status === 0, gen.stderr);

const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const lds = (html) => [...html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
const one = (html, re) => (html.match(re) || [])[1];

/* ───── every generated page ───── */
for (const path of SUBPAGE_PATHS) {
  const file = resolve(root, `.${path}`, 'index.html');
  if (!existsSync(file)) { ok(`${path}: page file exists`, false, file); continue; }
  const html = readFileSync(file, 'utf8');
  const h1s = html.match(/<h1[\s>]/g) || [];
  const title = one(html, /<title>([\s\S]*?)<\/title>/);
  const desc = one(html, /<meta name="description" content="([^"]*)"/);
  ok(`${path}: exactly one H1, a title (≤ 90 chars) and a meta description`, h1s.length === 1 && title && unesc(title).length <= 90 && desc && desc.length > 50, `${h1s.length} ${title}`);
  ok(`${path}: canonical is its own production URL`, html.includes(`<link rel="canonical" href="${DEFAULT_ORIGIN}${path}">`));
  const org = lds(html).find((d) => d['@type'] === 'ProfessionalService');
  ok(`${path}: carries the same ProfessionalService JSON-LD as the homepage`, org && JSON.stringify(org) === JSON.stringify(buildJsonLd(DEFAULT_CONTENT, DEFAULT_ORIGIN)));
  ok(`${path}: links to the contact form and shows the business email and WhatsApp`, html.includes('href="/#contact"') && html.includes(`mailto:${BUSINESS.email}`) && html.includes(BUSINESS.whatsappUrl));
  ok(`${path}: no unfilled [placeholder] text`, !/\[[A-Z][A-Z ]+\]/.test(html));
}

/* ───── FAQPage on each service page = the visible FAQ, word for word ───── */
for (const s of SERVICES) {
  const html = readFileSync(resolve(root, 'services', s.slug, 'index.html'), 'utf8');
  const faq = lds(html).find((d) => d['@type'] === 'FAQPage');
  const visible = [...html.matchAll(/<div class="faq__item"><h3>([\s\S]*?)<\/h3><p>([\s\S]*?)<\/p><\/div>/g)].map((m) => [unesc(m[1]), unesc(m[2])]);
  const schema = (faq?.mainEntity || []).map((q) => [q.name, q.acceptedAnswer?.text]);
  ok(`/services/${s.slug}: FAQPage questions and answers match the visible FAQ exactly (${s.faq.length})`, faq && visible.length === s.faq.length && JSON.stringify(visible) === JSON.stringify(schema), JSON.stringify({ visible: visible.length, schema: schema.length }));
}

/* ───── blog posts open with the direct answer ───── */
for (const b of POSTS) {
  const html = readFileSync(resolve(root, 'blog', b.slug, 'index.html'), 'utf8');
  ok(`/blog/${b.slug}: the first paragraph of the article is the direct answer`, unesc(one(html, /<div class="prose">\s*<p class="answer">([\s\S]*?)<\/p>/) || '') === b.answer);
}

/* ───── sitemap + llms.txt ───── */
const sitemap = readFileSync(resolve(root, 'public/sitemap.xml'), 'utf8');
const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
ok('sitemap.xml lists every page exactly once, homepage first', locs.length === PAGES.length && locs[0] === `${DEFAULT_ORIGIN}/` && PAGES.every((pg) => locs.includes(`${DEFAULT_ORIGIN}${pg.path}`)), JSON.stringify(locs));
ok('sitemap.xml lists no page that is not built (no /contact)', locs.every((u) => u === `${DEFAULT_ORIGIN}/` || SUBPAGE_PATHS.includes(u.slice(DEFAULT_ORIGIN.length))));
const llms = readFileSync(resolve(root, 'public/llms.txt'), 'utf8');
ok('llms.txt names the business, city, email and WhatsApp and links every service page', llms.startsWith(`# ${BUSINESS.name}`) && llms.includes(BUSINESS.city) && llms.includes(BUSINESS.email) && llms.includes(BUSINESS.whatsapp) && SERVICES.every((s) => llms.includes(`${DEFAULT_ORIGIN}/services/${s.slug}`)));
ok('robots.txt still points crawlers at the sitemap', readFileSync(resolve(root, 'public/robots.txt'), 'utf8').includes(`Sitemap: ${DEFAULT_ORIGIN}/sitemap.xml`));

/* ───── the homepage's static HTML (what a crawler that runs no JavaScript reads) matches the defaults ───── */
const index = readFileSync(resolve(root, 'index.html'), 'utf8');
ok('index.html <title> and description are the default SEO copy', index.includes(`<title>${esc(DEFAULT_CONTENT.seo.title)}</title>`) && index.includes(`<meta name="description" content="${esc(DEFAULT_CONTENT.seo.description)}">`));
ok('index.html static JSON-LD equals buildJsonLd(defaults)', JSON.stringify(lds(index)[0]) === JSON.stringify(buildJsonLd(DEFAULT_CONTENT, DEFAULT_ORIGIN)));
ok('index.html has exactly one H1, and it is the hero heading', (index.match(/<h1[\s>]/g) || []).length === 1 && unesc(one(index, /<h1 class="hero__h1" id="heroH1">([\s\S]*?)<\/h1>/) || '') === DEFAULT_CONTENT.hero.h1);
ok('index.html intro paragraph and "built for" line match the defaults', unesc(one(index, /<p class="lab__about" id="labIntro">([\s\S]*?)<\/p>/) || '') === DEFAULT_CONTENT.lab.intro && unesc(one(index, /<p class="who__line wrap" id="whoLine">([\s\S]*?)<\/p>/) || '') === DEFAULT_CONTENT.who.line);
ok('index.html contact block and footer show the city, email and WhatsApp', [BUSINESS.email, BUSINESS.whatsapp, BUSINESS.whatsappUrl, `${BUSINESS.city}, ${BUSINESS.country}`].every((t) => index.split(t).length >= 3));
ok('index.html work section is real client work, not placeholder concepts', !index.includes('Selected concepts') && index.includes('href="/work/its4u-mobiles"'));
ok('index.html footer copyright is the default', index.includes(esc(DEFAULT_CONTENT.footer.copyright)));

/* ───── withDefaults: fields added by this upgrade reach a database saved before it, without overwriting anything ───── */
const old = structuredClone(DEFAULT_CONTENT);
delete old.contact.whatsapp; delete old.hero.h1; old.contact.email = 'kept@example.com'; old.contact.location = '';
const up = withDefaults(old);
ok('withDefaults fills a field the stored section lacks (contact.whatsapp, hero.h1)', up.contact.whatsapp === DEFAULT_CONTENT.contact.whatsapp && up.hero.h1 === DEFAULT_CONTENT.hero.h1);
ok('withDefaults never replaces a stored value, even an empty one', up.contact.email === 'kept@example.com' && up.contact.location === '');
ok('withDefaults leaves stored arrays (e.g. the projects) as they are', JSON.stringify(withDefaults({ ...old, work: { ...old.work, items: [] } }).work.items) === '[]');

/* ───── the server serves each page at its address (when the site is built) ───── */
if (existsSync(resolve(root, 'dist', 'about', 'index.html'))) {
  const DB = join(tmpdir(), 'hk-pages-test.db');
  for (const s of ['', '-wal', '-shm']) rmSync(DB + s, { force: true });
  Object.assign(process.env, { SQLITE_PATH: DB, SMTP_HOST: '', SETUP_TOKEN: '', GOOGLE_CLIENT_ID: '', NODE_ENV: 'development' });
  delete process.env.DATABASE_URL;
  const { createApp } = await import(new URL('./app.js', import.meta.url).href);
  const { app, store } = await createApp();
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const path of SUBPAGE_PATHS) {
    const res = await fetch(base + path, { redirect: 'manual' });
    const html = await res.text();
    ok(`GET ${path} → 200 HTML, the built page`, res.status === 200 && /text\/html/.test(res.headers.get('content-type') || '') && html.includes(`<link rel="canonical" href="${DEFAULT_ORIGIN}${path}">`), String(res.status));
  }
  const slash = await fetch(`${base}/about/`, { redirect: 'manual' });
  ok('GET /about/ → 301 to /about (one address per page)', slash.status === 301 && slash.headers.get('location') === '/about', `${slash.status} ${slash.headers.get('location')}`);
  const nope = await fetch(`${base}/services/not-a-page`);
  ok('an unknown page is still a 404', nope.status === 404);
  server.close(); await store.close?.();
  for (const s of ['', '-wal', '-shm']) rmSync(DB + s, { force: true });
} else {
  console.log('SKIP  server routes — no built dist/ (run `npm run build` first)');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
