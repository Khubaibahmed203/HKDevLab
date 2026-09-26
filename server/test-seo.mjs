// Phase 1 SEO foundation: the shared meta/JSON-LD builder, the rule-based analyzer, and the /api/admin/seo/*
// endpoints. Runs the real app on a temporary SQLite database.   Run: node server/test-seo.mjs
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { rmSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DB = join(tmpdir(), 'hk-seo-test.db');
for (const s of ['', '-wal', '-shm']) rmSync(DB + s, { force: true });
Object.assign(process.env, { SQLITE_PATH: DB, SMTP_HOST: '', SETUP_TOKEN: '', GOOGLE_CLIENT_ID: '', NODE_ENV: 'development', CONTENT_TTL_MS: '100' });
delete process.env.DATABASE_URL;
delete process.env.PUBLIC_URL;   // exercise the DEFAULT_ORIGIN fallback, like production would use before a custom domain is set

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { (cond ? pass++ : fail++); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { injectSeo, buildJsonLd, DEFAULT_ORIGIN, esc } = await import(new URL('../content/seo.js', import.meta.url).href);
const { analyzeHomepage, scoreFromIssues } = await import(new URL('./seo/analyzers.js', import.meta.url).href);
const { DEFAULT_CONTENT } = await import(new URL('./content.js', import.meta.url).href);

/* ───────────── pure functions: injectSeo() against the real index.html ───────────── */
const rawHtml = readFileSync(resolve(root, 'index.html'), 'utf8');
const html = injectSeo(rawHtml, DEFAULT_CONTENT, DEFAULT_ORIGIN);

ok('title is injected (HTML-escaped)', html.includes(`<title>${esc(DEFAULT_CONTENT.seo.title)}</title>`));
ok('canonical points at the production origin', html.includes(`<link rel="canonical" href="${DEFAULT_ORIGIN}/">`));
ok('meta description matches content', new RegExp(`<meta name="description" content="${DEFAULT_CONTENT.seo.description.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`).test(html));
ok('og:url is absolute and matches canonical', html.includes(`<meta property="og:url" content="${DEFAULT_ORIGIN}/">`));
ok('og:site_name is present', html.includes('<meta property="og:site_name" content="HK DevLab">'));
ok('og:image is an absolute URL', html.includes(`<meta property="og:image" content="${DEFAULT_ORIGIN}/brand/og.jpg">`));
ok('twitter:title/description/image are all present', html.includes('name="twitter:title"') && html.includes('name="twitter:description"') && html.includes('name="twitter:image"'));
ok('JSON-LD block is content-driven, not the old hardcoded copy', html.includes(DEFAULT_CONTENT.seo.description) && !html.includes('Digital development studio building websites, web applications, AI solutions and custom software.'));

const ldMatch = html.match(/<script type="application\/ld\+json" id="ld-json">([\s\S]*?)<\/script>/);
const ld = ldMatch && JSON.parse(ldMatch[1]);
ok('JSON-LD parses and has the right shape', ld && ld['@context'] === 'https://schema.org' && ld['@type'] === 'ProfessionalService' && ld.url === `${DEFAULT_ORIGIN}/`);
ok('JSON-LD serviceType comes from content.lab.services, not invented', Array.isArray(ld.serviceType) && ld.serviceType.length === DEFAULT_CONTENT.lab.services.length);
ok('JSON-LD carries no invented reviews/ratings/address/prices', !('review' in ld) && !('aggregateRating' in ld) && !('address' in ld) && !('priceRange' in ld));

const escaping = injectSeo(rawHtml, { ...DEFAULT_CONTENT, seo: { ...DEFAULT_CONTENT.seo, title: 'Evil</script><script>alert(1)</script>' } }, DEFAULT_ORIGIN);
ok('a title containing "</script>" cannot break out of the JSON-LD script tag', !/<script>alert\(1\)<\/script>/.test(escaping));

ok('buildJsonLd is the same function render.js calls client-side (single source of truth)', JSON.stringify(buildJsonLd(DEFAULT_CONTENT, DEFAULT_ORIGIN)) === JSON.stringify(ld));

/* ───────────── analyzer: a deliberately broken page finds the right issues ───────────── */
const broken = '<html><head><title></title></head><body><h2>no h1</h2><img src="x.png"><a href="#missing">dead link</a></body></html>';
const brokenIssues = analyzeHomepage(broken, { robotsTxt: null, sitemapExists: false, origin: DEFAULT_ORIGIN });
const types = brokenIssues.map((i) => i.type);
for (const t of ['missing-title', 'missing-description', 'missing-canonical', 'missing-h1', 'missing-alt', 'broken-anchor-link', 'missing-json-ld', 'missing-robots-txt', 'missing-sitemap']) {
  ok(`broken page is flagged for ${t}`, types.includes(t));
}
ok('a badly broken page scores low', scoreFromIssues(brokenIssues) < 40, String(scoreFromIssues(brokenIssues)));

const clean = analyzeHomepage(html, { robotsTxt: 'User-agent: *\nAllow: /\nSitemap: https://hkdevlab.com/sitemap.xml', sitemapExists: true, origin: DEFAULT_ORIGIN });
const cleanCritical = clean.filter((i) => i.severity === 'critical');
ok('the real, fully-injected homepage has no critical findings', cleanCritical.length === 0, JSON.stringify(cleanCritical));

/* ───────────── HTTP: /api/admin/seo/* ───────────── */
const { createApp } = await import(new URL('./app.js', import.meta.url).href);
const { app, store } = await createApp();
const server = await new Promise((r) => { const s = app.listen(8832, () => r(s)); });
const base = 'http://localhost:8832';
process.env.PUBLIC_URL = base;   // Phase 2: /scan now runs a REAL network crawl — point it at this test's own
                                  // server, never at the real internet, so this test stays fast, offline and deterministic

let cookie = '';
async function call(method, path, { json, headers = {}, auth = true } = {}) {
  const h = { 'X-Requested-With': 'hk-admin', ...headers };
  if (json !== undefined) h['Content-Type'] = 'application/json';
  if (auth && cookie) h.Cookie = cookie;
  const res = await fetch(base + path, { method, headers: h, body: json !== undefined ? JSON.stringify(json) : undefined });
  for (const c of res.headers.getSetCookie?.() || []) { const [kv] = c.split(';'); const [k, v] = kv.split('='); cookie = v === '' ? '' : `${k}=${v}`; }
  let data = {}; try { data = await res.json(); } catch { /* not JSON */ }
  return { status: res.status, data };
}
// Phase 2.1: POST /scan only queues the job now (server/seo/jobs.js) — poll GET /scans/:id until it settles.
// The local fixture's own server is what gets crawled, so this is fast (usually done on the first poll).
async function pollScan(id, { maxAttempts = 100, delayMs = 25 } = {}) {
  for (let i = 0; i < maxAttempts; i++) {
    const r = await call('GET', `/api/admin/seo/scans/${id}`);
    if (r.data.audit && (r.data.audit.status === 'complete' || r.data.audit.status === 'failed')) return r;
    await new Promise((res2) => setTimeout(res2, delayMs));
  }
  throw new Error(`scan ${id} did not finish within ${maxAttempts * delayMs}ms`);
}

let r = await call('POST', '/api/admin/seo/scan', { auth: false });
ok('scanning without signing in is refused (401)', r.status === 401, String(r.status));

r = await call('POST', '/api/auth/setup', { json: { name: 'Test Admin', email: 'seo-test@example.com', password: 'a-long-test-password-1' } });
ok('test admin created', r.status === 201, JSON.stringify(r.data));

r = await call('POST', '/api/admin/seo/scan', { headers: { 'X-Requested-With': '' } });
ok('scanning without the anti-forgery header is refused (403)', r.status === 403, String(r.status));

/* ───────────── production crawl safety: the scan target is always a registered website, never a bare browser URL ───────────── */
r = await call('POST', '/api/admin/seo/scan', { json: { websiteId: 999999 } });
ok('an unregistered websiteId is refused (404), never silently crawled', r.status === 404, String(r.status));

r = await call('POST', '/api/admin/seo/scan', { json: { baseUrl: 'https://example.com/' } });
ok('a baseUrl on a different host than the registered website is refused (400) — arbitrary browser URLs are rejected', r.status === 400, String(r.status));

/* duplicate-scan protection: an audit already queued/running for this website blocks a second POST /scan */
const homeSite = await store.ensureWebsite('localhost:8832', 'HK DevLab');
const dupAudit = await store.createAudit(homeSite.id, { baseUrl: base, status: 'queued' });
r = await call('POST', '/api/admin/seo/scan');
ok('a second scan is refused (409) while one is already queued/running', r.status === 409 && r.data.audit.id === dupAudit.id, JSON.stringify(r.data));
await store.finishAudit(dupAudit.id, { status: 'failed', summary: 'test cleanup — never actually crawled' });   // unblock, and keep it out of "previous complete audit" comparisons below

/* ───────────── the real (async) scan ───────────── */
r = await call('POST', '/api/admin/seo/scan');
ok('POST /scan queues promptly (202) instead of crawling inline', r.status === 202 && r.data.ok && r.data.audit.status === 'queued', JSON.stringify(r.data));
const auditId = r.data.audit.id;

r = await pollScan(auditId);
ok('polling scans/:id eventually reports a completed audit', r.status === 200 && r.data.audit.status === 'complete', JSON.stringify(r.data));
ok('the completed audit carries a numeric score and issue count', typeof r.data.audit.score === 'number' && typeof r.data.audit.issueCount === 'number');
ok('the audit never targeted the real hkdevlab.com — only this test\'s own local server', r.data.audit.base_url.startsWith(base));

r = await call('GET', '/api/admin/seo/scans/latest');
ok('scans/latest returns the audit just run', r.status === 200 && r.data.audit.id === auditId, JSON.stringify(r.data));

r = await call('GET', `/api/admin/seo/scans/${auditId}`);
ok('scans/:id returns the same audit', r.status === 200 && r.data.audit.id === auditId);

r = await call('GET', '/api/admin/seo/scans/999999');
ok('an unknown audit id → 404', r.status === 404);

r = await call('GET', '/api/admin/seo/issues');
ok('issues are listed for the audit', r.status === 200 && Array.isArray(r.data.issues) && r.data.issues.length > 0, JSON.stringify(r.data).slice(0, 300));
ok('every issue has the SEOIssue shape', r.data.issues.every((i) => i.type && i.severity && i.status === 'open' && 'website_id' in i && 'audit_id' in i));

r = await call('GET', '/api/admin/seo/issues?severity=critical');
ok('severity filter only returns critical issues', r.data.issues.every((i) => i.severity === 'critical'));

r = await call('GET', '/api/admin/seo/issues', { auth: false });
ok('reading issues without signing in is refused (401)', r.status === 401, String(r.status));

/* the website row is not hardcoded — it comes from the same ensureWebsite() path a second site would use */
const w = await store.getWebsite(1);
ok('a website row was created for the configured domain (PUBLIC_URL), not literally in seo/ source code', w && w.domain === 'localhost:8832' && w.name === 'HK DevLab');

server.close();
await store.close();
for (const s of ['', '-wal', '-shm']) rmSync(DB + s, { force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
