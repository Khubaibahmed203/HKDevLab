// Phase 2 crawler, robots.txt, sitemap, HTML extraction and multi-page analyzer — all offline, against a
// tiny fixture HTTP server this file starts itself (never the real internet).   Run: node server/test-seo-crawl.mjs
import { createServer } from 'node:http';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { (cond ? pass++ : fail++); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };

const { normalizeUrl, sameSite } = await import(new URL('./seo/url.js', import.meta.url).href);
const { parseRobots, isAllowed, fetchRobots } = await import(new URL('./seo/robots.js', import.meta.url).href);
const { parseSitemapXml, discoverSitemaps } = await import(new URL('./seo/sitemap.js', import.meta.url).href);
const { extractPage } = await import(new URL('./seo/extract.js', import.meta.url).href);
const { crawlWebsite } = await import(new URL('./seo/crawler.js', import.meta.url).href);
const { analyzePages } = await import(new URL('./seo/pageAnalyzer.js', import.meta.url).href);

/* ───────────── pure functions: URL normalization ───────────── */
ok('normalizeUrl drops the fragment', normalizeUrl('https://EX.com/a#frag', 'https://ex.com') === 'https://ex.com/a');
ok('normalizeUrl lower-cases the host', normalizeUrl('https://EXAMPLE.com/a', 'https://x.com') === 'https://example.com/a');
ok('normalizeUrl drops a default port', normalizeUrl('https://ex.com:443/a', 'https://x.com') === 'https://ex.com/a');
ok('normalizeUrl drops one trailing slash (but not the root)', normalizeUrl('https://ex.com/a/', 'https://x.com') === 'https://ex.com/a' && normalizeUrl('https://ex.com/', 'https://x.com') === 'https://ex.com/');
ok('normalizeUrl resolves a relative href against its page', normalizeUrl('/x', 'https://ex.com/dir/page') === 'https://ex.com/x');
ok('normalizeUrl rejects non-http(s) schemes', normalizeUrl('javascript:alert(1)', 'https://ex.com') === null);
ok('normalizeUrl rejects a string that is not absolute and has no valid base to resolve against', normalizeUrl('not a url at all', undefined) === null);
ok('sameSite compares host only', sameSite('https://ex.com/a', 'ex.com') === true && sameSite('https://other.com/a', 'ex.com') === false);

/* ───────────── pure functions: robots.txt ───────────── */
const robotsTxt = `
User-agent: *
Disallow: /private
Allow: /private/public-ok
Disallow: /a-longer-and-more-specific-block

Sitemap: https://ex.com/sitemap.xml
`;
const parsed = parseRobots(robotsTxt);
ok('parseRobots finds the wildcard group and its rules', parsed.groups.some((g) => g.agents.includes('*') && g.rules.length === 3));
ok('parseRobots collects Sitemap: lines', parsed.sitemaps.includes('https://ex.com/sitemap.xml'));
ok('isAllowed: a disallowed path is blocked', isAllowed('/private/secret', parsed) === false);
ok('isAllowed: a more specific Allow overrides a shorter Disallow', isAllowed('/private/public-ok', parsed) === true);
ok('isAllowed: an unlisted path is allowed', isAllowed('/anything-else', parsed) === true);
ok('isAllowed with no robots data at all → allowed (fail open, not closed)', isAllowed('/x', { groups: [] }) === true);

/* ───────────── pure functions: sitemap XML ───────────── */
const sitemapXml = `<?xml version="1.0"?><urlset><url><loc>https://ex.com/a</loc><lastmod>2026-01-01</lastmod></url><url><loc>https://ex.com/b&amp;c</loc></url></urlset>`;
const sm = parseSitemapXml(sitemapXml);
ok('parseSitemapXml reads loc + lastmod', sm.entries.length === 2 && sm.entries[0].loc === 'https://ex.com/a' && sm.entries[0].lastmod === '2026-01-01');
ok('parseSitemapXml decodes XML entities in <loc>', sm.entries[1].loc === 'https://ex.com/b&c');
const idxXml = `<sitemapindex><sitemap><loc>https://ex.com/sub.xml</loc></sitemap></sitemapindex>`;
ok('parseSitemapXml detects a sitemap index', parseSitemapXml(idxXml).isIndex === true);

/* ───────────── pure functions: HTML extraction (cheerio) ───────────── */
const sampleHtml = `<!doctype html><html lang="en"><head><title>A Great Page Title Here</title>
<meta name="description" content="A reasonably long and useful meta description for testing purposes here.">
<link rel="canonical" href="https://ex.com/page">
<meta name="viewport" content="width=device-width">
<meta property="og:title" content="OG Title">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"WebPage"}</script>
</head><body>
<h1>Main heading</h1><h2>Sub</h2><h2>Sub 2</h2>
<img src="/a.png" alt="described"><img src="/b.png">
<p id="dup">one</p><p id="dup">two</p>
<a href="/internal">Internal link</a><a href="https://other.com/x">External</a><a href="mailto:x@y.com">skip me</a>
<p>${'word '.repeat(60)}</p>
</body></html>`;
const facts = extractPage(sampleHtml);
ok('extractPage: title/description/canonical', facts.title === 'A Great Page Title Here' && facts.description.startsWith('A reasonably long') && facts.canonical === 'https://ex.com/page');
ok('extractPage: heading counts', facts.h1Count === 1 && facts.h2Count === 2 && facts.headingLevels.length === 3);
ok('extractPage: image alt detection (present vs missing, not empty-string confusion)', facts.images.length === 2 && facts.missingAltCount === 1);
ok('extractPage: links exclude mailto:, include internal + external', facts.links.some((l) => l.href === '/internal') && facts.links.some((l) => l.href === 'https://other.com/x') && !facts.links.some((l) => l.href.startsWith('mailto:')));
ok('extractPage: duplicate ids detected', facts.duplicateIds === 1);
ok('extractPage: JSON-LD present + valid', facts.jsonLdPresent === true && facts.jsonLdValid === true);
ok('extractPage: word count is roughly right', facts.wordCount > 60 && facts.wordCount < 80, String(facts.wordCount));
ok('extractPage: viewport detected', facts.hasViewport === true);
const invalidLd = extractPage('<html><body><script type="application/ld+json">{not valid json}</script></body></html>');
ok('extractPage: invalid JSON-LD flagged, not silently accepted', invalidLd.jsonLdPresent === true && invalidLd.jsonLdValid === false);

/* ───────────── fixture HTTP server: a small link graph to crawl for real ───────────── */
const page = (title, bodyLinks) => `<!doctype html><html lang="en"><head><title>${title}</title>
<meta name="description" content="Description for ${title}, long enough to look real for testing.">
<link rel="canonical" href="SELF"><meta name="viewport" content="width=device-width">
</head><body><h1>${title}</h1>${bodyLinks}</body></html>`;

let PORT, BASE, ROBOTS_TXT, SITEMAP_XML;
const routes = {
  '/': () => page('Home', `<a href="/a">A</a><a href="/a">A again</a><a href="/b">B</a><a href="/trailing/">Trailing</a><a href="https://external-site.example/x">External</a><a href="/private/secret">Secret</a>`),
  '/a': () => page('Page A', `<a href="/deep1">Deep 1</a>`),
  '/deep1': () => page('Deep 1', `<a href="/deep2">Deep 2</a>`),
  '/deep2': () => page('Deep 2', `<a href="/deep3">Deep 3</a>`),
  '/deep3': () => page('Deep 3', ``),
  '/b': () => page('Page B', `<a href="/redirect-me">Redirect</a><a href="/broken">Broken</a>`),
  '/b-target': () => page('Redirect Target', ``),
  '/trailing': () => page('Trailing', ``),
  '/private/secret': () => page('Secret', ``),
};

const server = createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/robots.txt') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end(ROBOTS_TXT); }
  if (url === '/sitemap.xml') { res.writeHead(200, { 'content-type': 'application/xml' }); return res.end(SITEMAP_XML); }
  if (url === '/redirect-me') { res.writeHead(302, { location: '/b-target' }); return res.end(); }
  if (url === '/broken') { res.writeHead(404, { 'content-type': 'text/html' }); return res.end('<html><body>not found</body></html>'); }
  if (url === '/pdf-file') { res.writeHead(200, { 'content-type': 'application/pdf' }); return res.end('%PDF-1.4 fake'); }
  if (url === '/slow') {
    const timer = setTimeout(() => { try { if (!res.destroyed) { res.writeHead(200, { 'content-type': 'text/html' }); res.end(page('Slow', '')); } } catch { /* the client already gave up */ } }, 1500);
    req.on('aborted', () => clearTimeout(timer));
    res.on('close', () => clearTimeout(timer));
    return;
  }
  const builder = routes[url];
  if (!builder) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(builder().replace('SELF', `${BASE}${url === '/' ? '/' : url}`));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
PORT = server.address().port;
BASE = `http://127.0.0.1:${PORT}`;
ROBOTS_TXT = `User-agent: *\nDisallow: /private\n\nSitemap: ${BASE}/sitemap.xml\n`;
SITEMAP_XML = `<?xml version="1.0"?><urlset><url><loc>${BASE}/</loc></url><url><loc>${BASE}/a</loc></url><url><loc>https://not-this-domain.example/x</loc></url></urlset>`;

/* fetchRobots against the fixture */
const liveRobots = await fetchRobots(BASE, { timeoutMs: 3000 });
ok('fetchRobots reads the real robots.txt over HTTP', liveRobots.exists === true && liveRobots.sitemaps.includes(`${BASE}/sitemap.xml`));

/* discoverSitemaps against the fixture: finds it via robots.txt, rejects the out-of-domain entry's fetch */
const sitemaps = await discoverSitemaps(BASE, liveRobots.sitemaps, { timeoutMs: 3000, allowedHost: `127.0.0.1:${PORT}` });
ok('discoverSitemaps fetches the sitemap referenced from robots.txt', sitemaps.some((s) => s.url === `${BASE}/sitemap.xml` && !s.error));
ok('discoverSitemaps never fetches sitemap.xml twice for the same URL (candidates deduped)', sitemaps.filter((s) => s.url === `${BASE}/sitemap.xml`).length === 1);

/* the real crawl: same-domain only, depth-limited, dedup'd, robots-respecting */
const crawl = await crawlWebsite(BASE, { maxPages: 50, maxDepth: 5, requestTimeoutMs: 3000, crawlDelayMs: 0 });
const urls = crawl.pages.map((p) => p.url);
ok('crawl discovers same-domain pages', urls.includes(`${BASE}/`) && urls.includes(`${BASE}/a`) && urls.includes(`${BASE}/b`));
ok('crawl normalizes and dedups (two links to /a → one page, not two)', urls.filter((u) => u === `${BASE}/a`).length === 1);
ok('crawl normalizes a trailing slash to the same page as without one', urls.filter((u) => u === `${BASE}/trailing`).length === 1);
ok('crawl NEVER fetches an external domain', !urls.some((u) => u.includes('external-site.example')));
ok('…but DOES record the external link for analysis', crawl.links.some((l) => l.toUrl.includes('external-site.example') && l.isInternal === false));
ok('crawl follows a redirect and records both the start and final URL', crawl.pages.find((p) => p.url === `${BASE}/redirect-me`)?.finalUrl === `${BASE}/b-target`);
ok('crawl records a 404 as a page with statusCode 404, not as an error', crawl.pages.find((p) => p.url === `${BASE}/broken`)?.statusCode === 404);
ok('crawl respects robots.txt: /private/secret is never fetched for real', crawl.pages.find((p) => p.url === `${BASE}/private/secret`)?.disallowedByRobots === true && !crawl.pages.find((p) => p.url === `${BASE}/private/secret`)?.title);

/* depth limit: with maxDepth 2, /deep2 (depth 3) must never be reached */
const shallow = await crawlWebsite(BASE, { maxPages: 50, maxDepth: 2, requestTimeoutMs: 3000, crawlDelayMs: 0 });
const shallowUrls = shallow.pages.map((p) => p.url);
ok('maxDepth is enforced: a depth-2 page is reached…', shallowUrls.includes(`${BASE}/deep1`));
ok('…but a depth-3 page is not', !shallowUrls.includes(`${BASE}/deep2`));

/* page limit */
const capped = await crawlWebsite(BASE, { maxPages: 3, maxDepth: 5, requestTimeoutMs: 3000, crawlDelayMs: 0 });
ok('maxPages caps the number of pages fetched', capped.pages.length <= 3);
ok('a capped crawl reports itself truncated', capped.truncated === true);

/* per-request timeout */
const timedOut = await crawlWebsite(`${BASE}/slow`, { maxPages: 1, maxDepth: 0, requestTimeoutMs: 200, crawlDelayMs: 0 });
ok('a slow page times out rather than hanging the scan', timedOut.pages[0].statusCode == null && /timed out/.test(timedOut.pages[0].error || ''));

/* non-HTML resources are recorded, not parsed for links */
const withPdf = await crawlWebsite(`${BASE}/pdf-file`, { maxPages: 1, maxDepth: 0, requestTimeoutMs: 3000, crawlDelayMs: 0 });
ok('a non-HTML resource is recorded with its content type and no extracted links', withPdf.pages[0].contentType === 'application/pdf' && withPdf.pages[0].links === undefined);

server.close();

/* ───────────── analyzePages: cross-page checks over a hand-built crawl result ───────────── */
const synthetic = {
  origin: 'https://ex.com', allowedHost: 'ex.com',
  robots: { exists: true, groups: [], sitemaps: [] },
  sitemaps: [{ url: 'https://ex.com/sitemap.xml', error: null, entries: [{ loc: 'https://ex.com/' }, { loc: 'https://not-ex.com/rogue' }] }],
  pages: [
    { url: 'https://ex.com/', finalUrl: 'https://ex.com/', depth: 0, statusCode: 200, contentType: 'text/html', title: 'Same Title', description: 'Same Description', canonical: 'https://ex.com/', robotsMeta: '', lang: 'en', hasViewport: true, h1Count: 1, h2Count: 1, headingLevels: [1, 2], sectionsWithoutHeading: 0, images: [], missingAltCount: 0, jsonLdPresent: true, jsonLdValid: true, duplicateIds: 0, wordCount: 400 },
    { url: 'https://ex.com/dup', finalUrl: 'https://ex.com/dup', depth: 1, statusCode: 200, contentType: 'text/html', title: 'Same Title', description: 'Same Description', canonical: 'https://ex.com/dup', robotsMeta: '', lang: 'en', hasViewport: true, h1Count: 1, h2Count: 0, headingLevels: [1], sectionsWithoutHeading: 0, images: [], missingAltCount: 0, jsonLdPresent: true, jsonLdValid: true, duplicateIds: 0, wordCount: 400 },
    { url: 'https://ex.com/orphan', finalUrl: 'https://ex.com/orphan', depth: 1, statusCode: 200, contentType: 'text/html', title: 'Orphan', description: 'A totally different description here, long enough.', canonical: 'https://ex.com/orphan', robotsMeta: '', lang: 'en', hasViewport: true, h1Count: 1, h2Count: 0, headingLevels: [1], sectionsWithoutHeading: 0, images: [], missingAltCount: 0, jsonLdPresent: true, jsonLdValid: true, duplicateIds: 0, wordCount: 400 },
    { url: 'https://ex.com/gone', finalUrl: 'https://ex.com/gone', depth: 1, statusCode: 404, contentType: 'text/html' },
    { url: 'https://ex.com/moved', finalUrl: 'https://ex.com/moved-to', depth: 1, statusCode: 301, contentType: 'text/html' },
  ],
  links: [
    { fromUrl: 'https://ex.com/', toUrl: 'https://ex.com/dup', isInternal: true },
    { fromUrl: 'https://ex.com/', toUrl: 'https://ex.com/gone', isInternal: true },
    { fromUrl: 'https://ex.com/', toUrl: 'https://ex.com/moved', isInternal: true },
  ],
  errors: [],
};
const issues = analyzePages(synthetic);
const types = issues.map((i) => i.type);
ok('analyzePages: duplicate-title across pages', types.includes('duplicate-title'));
ok('analyzePages: duplicate-description across pages', types.includes('duplicate-description'));
ok('analyzePages: orphan page (no crawled page links to it)', issues.some((i) => i.type === 'orphan-page' && i.pageUrl === 'https://ex.com/orphan'));
ok('analyzePages: broken internal link (links to a 404)', issues.some((i) => i.type === 'broken-internal-link'));
ok('analyzePages: link to a redirecting page', issues.some((i) => i.type === 'link-to-redirect'));
ok('analyzePages: sitemap lists a URL outside the domain', types.includes('sitemap-external-url'));
ok('analyzePages: the homepage itself is never flagged as an orphan', !issues.some((i) => i.type === 'orphan-page' && i.pageUrl === 'https://ex.com/'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
