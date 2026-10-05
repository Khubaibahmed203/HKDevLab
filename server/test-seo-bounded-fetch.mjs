// Phase 4 Hardening #4 — crawl requests are bounded in TIME and in SIZE, body included.
// Before this step fetchWithTimeout() stopped its timer the moment the response HEADERS arrived, and the callers then did
// `await res.text()` with no deadline and no byte limit: a server that sends headers and then drips (or never finishes) the
// body could hang a crawl forever (the audit stays 'running', the worker leaks and can become the zombie of the stale-audit
// audit), and a huge body was read whole into memory.
// fetchBounded() now covers fetch -> headers -> the entire body with ONE deadline, cancels the underlying request (closes the
// socket) when the deadline or the size cap is hit, and counts the bytes actually received while streaming.
//
// Every scenario runs against loopback HTTP servers this file starts (never the real internet), and every operation that could
// hang if the code under test were broken is raced against a hard deadline — so a regression (or a mutation) fails an
// assertion; it never hangs the suite.
// Run: node server/test-seo-bounded-fetch.mjs
import http from 'node:http';
import zlib from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { newDb } from 'pg-mem';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { (cond ? pass++ : fail++); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };
const unhandled = [];
process.on('unhandledRejection', (e) => { unhandled.push(e); });
setTimeout(() => { console.log('FAIL  watchdog: the whole suite exceeded 4 minutes'); process.exit(2); }, 240_000).unref();

for (const k of ['SEO_HTML_MAX_BYTES', 'SEO_ROBOTS_MAX_BYTES', 'SEO_SITEMAP_MAX_BYTES', 'SEO_REQUEST_TIMEOUT_MS', 'SEO_CRAWL_DELAY_MS', 'SEO_MAX_PAGES', 'SEO_MAX_DEPTH', 'SEO_STALE_AUDIT_MS', 'PAGESPEED_API_KEY', 'DATABASE_URL']) delete process.env[k];
Object.assign(process.env, { SMTP_HOST: '', NODE_ENV: 'development' });

const H = await import(new URL('./seo/http.js', import.meta.url).href);
const { fetchBounded, RequestTimeoutError, ResponseTooLargeError, htmlMaxBytes, robotsMaxBytes, sitemapMaxBytes } = H;
const { fetchRobots } = await import(new URL('./seo/robots.js', import.meta.url).href);
const { discoverSitemaps } = await import(new URL('./seo/sitemap.js', import.meta.url).href);
const { crawlWebsite } = await import(new URL('./seo/crawler.js', import.meta.url).href);
const { staleAuditMs, crawlLimits } = await import(new URL('./seo/limits.js', import.meta.url).href);
const src = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const MiB = 1024 * 1024;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Runs fn and resolves to { ok, value | error, ms }, or { hung: true } if it has not settled within capMs. */
async function attempt(fn, capMs = 8000) {
  const t0 = Date.now();
  const r = await Promise.race([
    Promise.resolve().then(fn).then((value) => ({ ok: true, value }), (error) => ({ ok: false, error })),
    new Promise((res) => setTimeout(() => res({ hung: true }), capMs)),
  ]);
  return { ...r, ms: Date.now() - t0 };
}
async function until(cond, capMs = 3000) { const t0 = Date.now(); while (!cond() && Date.now() - t0 < capMs) await sleep(10); return cond(); }
const withEnv = async (vars, fn) => { const old = {}; for (const k of Object.keys(vars)) { old[k] = process.env[k]; process.env[k] = vars[k]; } try { return await fn(); } finally { for (const k of Object.keys(vars)) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } } };

/** A loopback server that remembers, per request, whether its connection got closed and whether it finished normally. */
const servers = [];
async function serve(handler) {
  const sockets = new Set(), reqs = [];
  const s = http.createServer((req, res) => {
    const st = { path: req.url, closed: false, finished: false };
    reqs.push(st);
    res.on('close', () => { st.closed = true; st.finished = res.writableFinished; });
    handler(req, res, st);
  });
  s.on('connection', (k) => { sockets.add(k); k.on('close', () => sockets.delete(k)); });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const port = s.address().port;
  const entry = { port, base: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}`, reqs, last: () => reqs[reqs.length - 1], close() { for (const k of sockets) k.destroy(); s.close(); } };
  servers.push(entry);
  return entry;
}
const html = (title, body = '') => `<!doctype html><html lang="en"><head><title>${title}</title><meta name="description" content="A description for ${title} that is comfortably long enough."></head><body><h1>${title}</h1>${body}</body></html>`;
/** headers now, then one byte every 30 ms for ever */
const drip = (res, type, first) => { res.writeHead(200, { 'content-type': type }); res.write(first); const t = setInterval(() => res.write('a'), 30); res.on('close', () => clearInterval(t)); };
/** an endless chunked body (no Content-Length), written with backpressure */
const endless = (res, type, first) => {
  res.writeHead(200, { 'content-type': type }); res.write(first);
  const chunk = Buffer.alloc(64 * 1024, 0x61); let stopped = false; res.on('close', () => { stopped = true; });
  const pump = () => { while (!stopped) { if (!res.write(chunk)) { res.once('drain', pump); return; } } };
  pump();
};
const bytesOfHtml = (n) => { const head = '<html><head><title>big</title></head><body>', tail = '</body></html>'; return head + 'a'.repeat(n - head.length - tail.length) + tail; };   // exactly n bytes (ASCII)
const timeoutKinds = (r) => r.ok === false && r.error?.code === 'REQUEST_TIMEOUT' && r.error instanceof RequestTimeoutError && r.error.message === 'request timed out';
const tooLarge = (r, max) => r.ok === false && r.error?.code === 'RESPONSE_TOO_LARGE' && r.error instanceof ResponseTooLargeError && r.error.message === 'response body exceeds maximum size' && r.error.maxBytes === max;

/* ═════════ 0. the approved limits and their environment overrides ═════════ */
ok('0. defaults are exactly the approved ones: HTML 5 MiB = 5242880, robots 1 MiB = 1048576, sitemap 10 MiB = 10485760', htmlMaxBytes() === 5242880 && robotsMaxBytes() === 1048576 && sitemapMaxBytes() === 10485760);
{
  const vars = { html: 'SEO_HTML_MAX_BYTES', robots: 'SEO_ROBOTS_MAX_BYTES', sitemap: 'SEO_SITEMAP_MAX_BYTES' };
  const fn = { html: htmlMaxBytes, robots: robotsMaxBytes, sitemap: sitemapMaxBytes };
  const dflt = { html: 5242880, robots: 1048576, sitemap: 10485760 };
  for (const key of Object.keys(vars)) {
    const bad = [];
    for (const v of ['', '   ', 'abc', '0', '-5', '-1048576', '1.5', '1e6', '0x10', '12abc', 'Infinity', 'NaN', '99999999999999999999', '007']) { process.env[vars[key]] = v; if (fn[key]() !== dflt[key]) bad.push(JSON.stringify(v)); }
    ok(`0. ${vars[key]}: every unusable value (blank, zero, negative, fractional, exponent, hex, junk, beyond the safe-integer range) falls back to the approved default — never to "no limit" or 0`, bad.length === 0, bad.join(' '));
    process.env[vars[key]] = '12345'; ok(`0. ${vars[key]}: a plain positive integer is honored (and read at call time, not module load)`, fn[key]() === 12345);
    process.env[vars[key]] = ' 777 '; ok(`0. ${vars[key]}: surrounding whitespace is tolerated`, fn[key]() === 777);
    delete process.env[vars[key]];
  }
  process.env.SEO_HTML_MAX_BYTES = '111'; process.env.SEO_ROBOTS_MAX_BYTES = '222'; process.env.SEO_SITEMAP_MAX_BYTES = '333';
  ok('0. the three overrides are independent: each resource reads only its own variable', htmlMaxBytes() === 111 && robotsMaxBytes() === 222 && sitemapMaxBytes() === 333);
  delete process.env.SEO_HTML_MAX_BYTES; delete process.env.SEO_ROBOTS_MAX_BYTES; delete process.env.SEO_SITEMAP_MAX_BYTES;
  const noGlobal = ['SEO_MAX_RESPONSE_BYTES', 'SEO_MAX_BYTES', 'SEO_RESPONSE_MAX_BYTES'];
  for (const g of noGlobal) process.env[g] = '10';
  ok('0. there is no global response-size variable: setting one changes none of the three limits', htmlMaxBytes() === 5242880 && robotsMaxBytes() === 1048576 && sitemapMaxBytes() === 10485760);
  for (const g of noGlobal) delete process.env[g];
}
{
  const bad = [];
  for (const v of [undefined, null, 0, -1, 1.5, NaN, Infinity, '100', {}]) { const r = await attempt(() => fetchBounded('http://127.0.0.1:9/', { maxBytes: v })); if (!(r.ok === false && r.error instanceof TypeError)) bad.push(String(v)); }
  ok('0. fetchBounded refuses to run without an explicit positive integer maxBytes (so no call site can be accidentally unbounded)', bad.length === 0, bad.join(' '));
}

/* ═════════ A / B / C. a body that never finishes is cut off by the deadline — HTML, robots.txt, sitemap ═════════ */
{
  const s = await serve((req, res) => {
    if (req.url === '/') return drip(res, 'text/html', '<html><head><title>x</title></head><body>');
    if (req.url === '/robots.txt') return drip(res, 'text/plain', 'User-agent: *\n');
    if (req.url === '/sitemap.xml') return drip(res, 'application/xml', '<urlset>');
    res.writeHead(404); res.end();
  });

  const a1 = await attempt(() => fetchBounded(`${s.base}/`, { timeoutMs: 300, maxBytes: htmlMaxBytes(), readBody: () => true }), 5000);
  ok('A. HTML: headers arrive at once but the body drips for ever — the request fails with the deterministic timeout error', !a1.hung && timeoutKinds(a1), JSON.stringify(a1).slice(0, 200));
  ok('A. …and it fails at the deadline (not before it, and nowhere near "never")', a1.ms >= 250 && a1.ms < 2500, `${a1.ms}ms`);
  const a2 = await attempt(() => crawlWebsite(`${s.base}/`, { maxPages: 1, requestTimeoutMs: 300, crawlDelayMs: 0 }), 8000);
  ok('A. through the crawler: the page becomes an ordinary page error ("timed out after 300ms", no status code) and the crawl finishes', !a2.hung && a2.ok && a2.value.pages[0]?.error === 'timed out after 300ms' && a2.value.pages[0]?.statusCode == null && a2.value.errors.some((e) => e.error === 'timed out after 300ms'), JSON.stringify(a2).slice(0, 200));

  const b = await attempt(() => fetchRobots(s.base, { timeoutMs: 300 }), 5000);
  ok('B. robots.txt: a body that never finishes ends in the existing "robots.txt unavailable" result within the deadline', !b.hung && b.ok && b.value.exists === false && b.ms < 2500, JSON.stringify(b).slice(0, 160));
  const b2 = await attempt(() => fetchBounded(`${s.base}/robots.txt`, { timeoutMs: 300, maxBytes: robotsMaxBytes(), readBody: (r) => r.ok }), 5000);
  ok('B. …and the cause is the deadline (the timeout error), not something else', timeoutKinds(b2));

  const c = await attempt(() => discoverSitemaps(s.base, [], { timeoutMs: 300, allowedHost: s.host }), 5000);
  ok('C. sitemap: a body that never finishes becomes an entry with the deterministic timeout error, no entries, within the deadline', !c.hung && c.ok && c.value[0]?.url === `${s.base}/sitemap.xml` && c.value[0].error === 'request timed out' && c.value[0].entries.length === 0 && c.ms < 2500, JSON.stringify(c).slice(0, 200));

  // N (timeouts): the request is actually CANCELLED, not merely abandoned — the server sees its connection close and never finishes
  const sawClose = await until(() => s.reqs.every((r) => r.closed));
  ok('N. after a body timeout the server side sees every connection closed (the request was aborted, not left open)', sawClose && s.reqs.every((r) => r.closed && !r.finished), JSON.stringify(s.reqs));
  s.close();
}

/* ═════════ D / E / H. the size cap — Content-Length, chunked, and a lying/absent length ═════════ */
{
  const s = await serve((req, res, st) => {
    const n = +req.url.split('n=')[1];
    if (req.url.startsWith('/len')) { const body = bytesOfHtml(n); res.writeHead(200, { 'content-type': 'text/html', 'content-length': Buffer.byteLength(body) }); return res.end(body); }
    if (req.url.startsWith('/chunked-end')) { const body = bytesOfHtml(n); res.writeHead(200, { 'content-type': 'text/html' }); res.write(body.slice(0, 1000)); return setTimeout(() => res.end(body.slice(1000)), 20); }   // no Content-Length: chunked
    if (req.url === '/endless') { st.chunked = true; return endless(res, 'text/html', '<html><body>'); }
    if (req.url === '/bomb') {
      const compressed = zlib.gzipSync(Buffer.from(bytesOfHtml(6 * MiB)));
      st.compressedLength = compressed.length;
      res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip', 'content-length': compressed.length });
      return res.end(compressed);
    }
    if (req.url === '/liar') { res.writeHead(200, { 'content-type': 'text/html', 'content-length': 99_999_999 }); res.write('<html>'); return; }   // promises 95 MB, sends 6 bytes, then goes quiet
    res.writeHead(404); res.end();
  });
  const get = (path, max = htmlMaxBytes(), timeoutMs = 10000) => attempt(() => fetchBounded(`${s.base}${path}`, { timeoutMs, maxBytes: max, readBody: () => true }), 12000);

  const atCap = await get(`/len?n=${5 * MiB}`);
  ok('D. HTML exactly at the 5 MiB cap (5242880 bytes) is accepted in full', atCap.ok && atCap.value.text.length === 5 * MiB && atCap.value.status === 200, JSON.stringify(atCap).slice(0, 120));
  const over = await get(`/len?n=${5 * MiB + 1}`);
  ok('D. HTML one byte over 5 MiB, declared by Content-Length, is rejected with the deterministic size error (and is not returned truncated)', tooLarge(over, 5242880), JSON.stringify(over).slice(0, 200));
  const overBig = await get(`/len?n=${8 * MiB}`);
  ok('D. …a much larger one too', tooLarge(overBig, 5242880));

  const chunkedAt = await get(`/chunked-end?n=${5 * MiB}`);
  ok('E. chunked HTML (no Content-Length) exactly at the cap is accepted', chunkedAt.ok && chunkedAt.value.text.length === 5 * MiB && chunkedAt.value.headers.get('content-length') === null, JSON.stringify(chunkedAt).slice(0, 120));
  const chunkedOver = await get(`/chunked-end?n=${5 * MiB + 1}`);
  ok('E. chunked HTML one byte over the cap is rejected once the ACTUAL bytes exceed it (no length header to rely on)', tooLarge(chunkedOver, 5242880), JSON.stringify(chunkedOver).slice(0, 200));
  const stream = await get('/endless', htmlMaxBytes(), 3000);   // 5 MiB over loopback takes milliseconds; a short deadline turns a missing cap into a failed assertion, not an out-of-memory crash
  ok('E. an endless chunked body is cut off at the cap instead of being read for ever', !stream.hung && tooLarge(stream, 5242880), JSON.stringify(stream).slice(0, 160));
  ok('N. …and the oversized response is cancelled: the server sees the connection close without ever finishing', await until(() => s.reqs.find((r) => r.path === '/endless')?.closed === true) && s.reqs.find((r) => r.path === '/endless').finished === false);

  const bomb = await get('/bomb');
  const bombReq = s.reqs.find((r) => r.path === '/bomb');
  ok('H. a small Content-Length cannot bypass the cap: a 6 MiB body gzip-compressed to a few KB (declared length far below 5 MiB) is rejected on its decoded bytes', bombReq.compressedLength < 100_000 && tooLarge(bomb, 5242880), `${bombReq.compressedLength} ${JSON.stringify(bomb).slice(0, 160)}`);
  const liar = await get('/liar', htmlMaxBytes(), 3000);
  ok('H. a Content-Length that already exceeds the cap is an EARLY rejection — it fails at once instead of waiting for the deadline', tooLarge(liar, 5242880) && liar.ms < 1500, `${liar.ms}ms ${JSON.stringify(liar).slice(0, 120)}`);
  ok('N. …and that early rejection also cancels the request', await until(() => s.reqs.find((r) => r.path === '/liar')?.closed === true));
  s.close();
}

/* ═════════ F. robots.txt cap (1 MiB) and G. sitemap cap (10 MiB), through the real code paths ═════════ */
{
  const s = await serve((req, res) => {
    const m = /^\/(robots\.txt|sitemap\.xml)\?n=(\d+)/.exec(req.url) || [];
    const n = +m[2];
    if (m[1] === 'robots.txt') { const body = '# ' + 'x'.repeat(n - 2); res.writeHead(200, { 'content-type': 'text/plain', 'content-length': n }); return res.end(body); }
    if (m[1] === 'sitemap.xml') { const open = '<urlset><!--', close = '--></urlset>'; const body = open + 'x'.repeat(n - open.length - close.length) + close; res.writeHead(200, { 'content-type': 'application/xml' }); return res.end(body); }   // chunked
    if (req.url === '/robots.txt') { res.writeHead(404); return res.end(); }
    res.writeHead(404); res.end();
  });
  const robotsAt = async (n) => { const r = await attempt(() => fetchBounded(`${s.base}/robots.txt?n=${n}`, { timeoutMs: 10000, maxBytes: robotsMaxBytes(), readBody: (x) => x.ok }), 12000); return r; };
  const at = await robotsAt(1 * MiB), over = await robotsAt(1 * MiB + 1);
  ok('F. robots.txt exactly at 1 MiB (1048576 bytes) is accepted', at.ok && at.value.text.length === 1 * MiB, JSON.stringify(at).slice(0, 120));
  ok('F. robots.txt one byte over 1 MiB is rejected with the size error', tooLarge(over, 1048576), JSON.stringify(over).slice(0, 200));
  // through fetchRobots(): the SAME url shape, but its path must be /robots.txt — so serve it from a second server
  const r2 = await serve((req, res, st) => {
    if (req.url === '/robots.txt') { const body = '# ' + 'x'.repeat(2 * MiB); res.writeHead(200, { 'content-type': 'text/plain', 'content-length': Buffer.byteLength(body) }); return res.end(body); }
    res.writeHead(404); res.end();
  });
  const fr = await attempt(() => fetchRobots(r2.base, { timeoutMs: 10000 }), 12000);
  ok('F. fetchRobots() on a 2 MiB robots.txt gives the existing "unavailable" result (exists:false) — never a truncated, half-parsed file', fr.ok && fr.value.exists === false && fr.value.groups.length === 0 && fr.value.sitemaps.length === 0, JSON.stringify(fr).slice(0, 160));
  const r3 = await serve((req, res) => { if (req.url === '/robots.txt') return endless(res, 'text/plain', 'User-agent: *\nDisallow: /x\n'); res.writeHead(404); res.end(); });
  const fr3 = await attempt(() => fetchRobots(r3.base, { timeoutMs: 3000 }), 8000);
  ok('F. an endless robots.txt (no Content-Length) is cut off at 1 MiB too', fr3.ok && fr3.value.exists === false && fr3.ms < 2500, JSON.stringify(fr3).slice(0, 120));
  ok('N. …and its connection is cancelled', await until(() => r3.reqs.find((r) => r.path === '/robots.txt')?.closed === true) && r3.reqs[0].finished === false);

  const sitemapAt = (n) => attempt(() => fetchBounded(`${s.base}/sitemap.xml?n=${n}`, { timeoutMs: 10000, maxBytes: sitemapMaxBytes(), readBody: (x) => x.ok }), 12000);
  const sat = await sitemapAt(10 * MiB), sover = await sitemapAt(10 * MiB + 1);
  ok('G. a sitemap exactly at 10 MiB (10485760 bytes) is accepted', sat.ok && sat.value.text.length === 10 * MiB, JSON.stringify(sat).slice(0, 120));
  ok('G. a sitemap one byte over 10 MiB is rejected with the size error', tooLarge(sover, 10485760), JSON.stringify(sover).slice(0, 200));
  const s2 = await serve((req, res) => {
    if (req.url === '/sitemap.xml') { const body = '<urlset><!--' + 'x'.repeat(11 * MiB) + '--></urlset>'; res.writeHead(200, { 'content-type': 'application/xml' }); return res.end(body); }
    res.writeHead(404); res.end();
  });
  const ds = await attempt(() => discoverSitemaps(s2.base, [], { timeoutMs: 10000, allowedHost: s2.host }), 12000);
  ok('G. discoverSitemaps() on an 11 MiB sitemap records the deterministic size error with no entries — never a truncated parse', ds.ok && ds.value[0]?.error === 'response body exceeds maximum size' && ds.value[0].entries.length === 0, JSON.stringify(ds).slice(0, 200));
  ok('the three resource limits are separate: the same 2 MiB body is fine as a sitemap (< 10 MiB) and HTML (< 5 MiB) but is over the robots.txt cap', (await attempt(() => fetchBounded(`${r2.base}/robots.txt`, { timeoutMs: 10000, maxBytes: sitemapMaxBytes(), readBody: () => true }), 12000)).ok && (await attempt(() => fetchBounded(`${r2.base}/robots.txt`, { timeoutMs: 10000, maxBytes: htmlMaxBytes(), readBody: () => true }), 12000)).ok && !(await attempt(() => fetchBounded(`${r2.base}/robots.txt`, { timeoutMs: 10000, maxBytes: robotsMaxBytes(), readBody: () => true }), 12000)).ok);
  s.close(); r2.close(); r3.close(); s2.close();
}

/* ═════════ I / J / K / L. behavior that must NOT change ═════════ */
{
  const pageHtml = html('Plain Page', '<a href="/next">next</a>');
  const s = await serve((req, res) => {
    if (req.url === '/robots.txt' || req.url === '/sitemap.xml') { res.writeHead(404); return res.end(); }
    if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(pageHtml); }
    if (req.url === '/r') { res.writeHead(302, { location: '/target' }); return res.end(); }
    if (req.url === '/target') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(html('Redirect Target')); }
    if (req.url === '/missing') { res.writeHead(404, { 'content-type': 'text/html' }); return res.end('<html><body>not found</body></html>'); }
    if (req.url === '/missing-text') { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('nope'); }
    if (req.url === '/pdf') { res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': 13 }); return res.end('%PDF-1.4 fake'); }
    if (req.url === '/slow-headers') { const t = setTimeout(() => { try { res.writeHead(200, { 'content-type': 'text/html' }); res.end(html('late')); } catch { /* the client gave up */ } }, 1500); res.on('close', () => clearTimeout(t)); return; }
    if (req.url === '/slow-body') { res.writeHead(200, { 'content-type': 'text/html' }); res.flushHeaders(); const t = setTimeout(() => res.end(html('Slow Body')), 600); res.on('close', () => clearTimeout(t)); return; }
    if (req.url === '/delayed-headers') { const t = setTimeout(() => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(html('Delayed')); }, 150); res.on('close', () => clearTimeout(t)); return; }
    if (req.url === '/big-ok') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(bytesOfHtml(4 * MiB)); }
    res.writeHead(404); res.end();
  });
  const bounded = (path, over = {}) => attempt(() => fetchBounded(`${s.base}${path}`, { timeoutMs: 3000, maxBytes: htmlMaxBytes(), readBody: () => true, ...over }), 8000);

  const plain = await fetch(`${s.base}/`); const plainText = await plain.text();
  const i = await bounded('/');
  ok('I. a normal page returns exactly what fetch + res.text() returns: status, ok, final url, content-type header and body text', i.ok && i.value.status === plain.status && i.value.ok === plain.ok && i.value.url === plain.url && i.value.headers.get('content-type') === plain.headers.get('content-type') && i.value.text === plainText && typeof i.value.ttfbMs === 'number', JSON.stringify(i).slice(0, 160));
  const big = await bounded('/big-ok');
  ok('I. a large page that is still under the cap (4 MiB) is returned whole', big.ok && big.value.text.length === 4 * MiB);
  const crawl = await attempt(() => crawlWebsite(s.base, { maxPages: 5, maxDepth: 1, requestTimeoutMs: 3000, crawlDelayMs: 0 }), 10000);
  const home = crawl.value?.pages.find((p) => p.url === `${s.base}/`);
  ok('I. the crawler records the same facts as before for a normal page (title, status, content type, htmlSize = the body\'s byte length, no error)', crawl.ok && home?.title === 'Plain Page' && home.statusCode === 200 && /text\/html/.test(home.contentType) && home.htmlSize === Buffer.byteLength(pageHtml) && home.error === null && home.links?.length === 1, JSON.stringify(home || crawl).slice(0, 200));

  const rd = await bounded('/r');
  ok('J. a redirect is still followed (unchanged by this hardening): final URL and the target body are returned', rd.ok && rd.value.url === `${s.base}/target` && rd.value.status === 200 && /Redirect Target/.test(rd.value.text), JSON.stringify(rd).slice(0, 160));
  const rdCrawl = await attempt(() => crawlWebsite(`${s.base}/r`, { maxPages: 1, maxDepth: 0, requestTimeoutMs: 3000, crawlDelayMs: 0 }), 8000);
  ok('J. …and the crawler still records both the start URL and the final URL', rdCrawl.ok && rdCrawl.value.pages[0].url === `${s.base}/r` && rdCrawl.value.pages[0].finalUrl === `${s.base}/target` && rdCrawl.value.pages[0].redirected === true);

  const m = await bounded('/missing');
  ok('K. a 404 HTML page is returned as a normal response (status 404, ok false) — not an error', m.ok && m.value.status === 404 && m.value.ok === false && /not found/.test(m.value.text));
  const mCrawl = await attempt(() => crawlWebsite(`${s.base}/missing`, { maxPages: 1, maxDepth: 0, requestTimeoutMs: 3000, crawlDelayMs: 0 }), 8000);
  ok('K. …and the crawler still records it as a page with statusCode 404 (not as an error)', mCrawl.ok && mCrawl.value.pages[0].statusCode === 404 && mCrawl.value.pages[0].error === null);
  const mt = await bounded('/missing-text', { readBody: (r) => /text\/html/.test(r.headers.get('content-type') || '') });
  ok('K. a body the caller does not want (non-HTML) is not read at all: text is null, headers are still there', mt.ok && mt.value.status === 404 && mt.value.text === null && mt.value.headers.get('content-type') === 'text/plain');
  const robots404 = await attempt(() => fetchRobots(s.base, { timeoutMs: 3000 }), 8000);
  const sitemap404 = await attempt(() => discoverSitemaps(s.base, [], { timeoutMs: 3000, allowedHost: s.host }), 8000);
  ok('K. robots.txt 404 is still {exists:false}; a sitemap 404 is still "HTTP 404"', robots404.ok && robots404.value.exists === false && sitemap404.ok && sitemap404.value[0]?.error === 'HTTP 404');
  const pdf = await attempt(() => crawlWebsite(`${s.base}/pdf`, { maxPages: 1, maxDepth: 0, requestTimeoutMs: 3000, crawlDelayMs: 0 }), 8000);
  ok('K. a non-HTML resource is still recorded with its content type and Content-Length size, and no extracted links', pdf.ok && pdf.value.pages[0].contentType === 'application/pdf' && pdf.value.pages[0].htmlSize === 13 && pdf.value.pages[0].links === undefined);

  const sh = await bounded('/slow-headers', { timeoutMs: 300 });
  ok('L. slow HEADERS still hit the deadline (the existing header-timeout behavior is intact)', timeoutKinds(sh) && sh.ms >= 250 && sh.ms < 2500, JSON.stringify(sh).slice(0, 160));
  const shCrawl = await attempt(() => crawlWebsite(`${s.base}/slow-headers`, { maxPages: 1, maxDepth: 0, requestTimeoutMs: 200, crawlDelayMs: 0 }), 8000);
  ok('L. …and the crawler still reports it as "timed out after 200ms"', shCrawl.ok && /timed out after 200ms/.test(shCrawl.value.pages[0].error || '') && shCrawl.value.pages[0].statusCode == null);
  ok('N. …and the slow-headers request is cancelled on the server side too', await until(() => s.reqs.filter((r) => r.path === '/slow-headers').every((r) => r.closed && !r.finished)));

  const slowBody = await attempt(() => crawlWebsite(`${s.base}/slow-body`, { maxPages: 1, maxDepth: 0, requestTimeoutMs: 3000, crawlDelayMs: 0 }), 8000);
  const delayed = await attempt(() => crawlWebsite(`${s.base}/delayed-headers`, { maxPages: 1, maxDepth: 0, requestTimeoutMs: 3000, crawlDelayMs: 0 }), 8000);
  ok('I. a page\'s recorded responseTimeMs is still the time the server took to ANSWER (headers), not how long its body took: a 600 ms body behind instant headers is ~0, and 150 ms-late headers are ~150', slowBody.ok && slowBody.value.pages[0].error === null && slowBody.value.pages[0].responseTimeMs < 400 && delayed.ok && delayed.value.pages[0].responseTimeMs >= 120 && delayed.value.pages[0].responseTimeMs < 1000, `${slowBody.value?.pages[0].responseTimeMs} / ${delayed.value?.pages[0].responseTimeMs}`);
  s.close();
}

/* ═════════ M. UTF-8: a multi-byte character split across chunks decodes whole, exactly like Response.text() ═════════ */
{
  const text = '<html><head><title>€uro — 日本語 😀 é</title></head><body>' + '€'.repeat(40) + '日本語'.repeat(10) + '😀'.repeat(10) + 'ñ</body></html>';
  const bytes = Buffer.from(text, 'utf8');
  const realFetch = globalThis.fetch;
  const stubbed = async (chunks, headers = { 'content-type': 'text/html' }) => {
    globalThis.fetch = async () => new Response(new ReadableStream({ start(c) { for (const ch of chunks) c.enqueue(ch); c.close(); } }), { status: 200, headers });
    try { return await attempt(() => fetchBounded('http://stub.invalid/', { timeoutMs: 3000, maxBytes: htmlMaxBytes(), readBody: () => true }), 5000); } finally { globalThis.fetch = realFetch; }
  };
  const splitAt = (buf, size) => { const out = []; for (let o = 0; o < buf.length; o += size) out.push(new Uint8Array(buf.subarray(o, o + size))); return out; };
  const results = {};
  for (const size of [1, 2, 3, 5, 7]) results[size] = await stubbed(splitAt(bytes, size));
  ok('M. UTF-8 text (€ = 3 bytes, 日本語 = 3 each, 😀 = 4, é/ñ = 2) delivered in 1, 2, 3, 5 and 7-byte chunks — every character straddles a chunk boundary somewhere — decodes to exactly the original string', Object.values(results).every((r) => r.ok && r.value.text === text), Object.entries(results).filter(([, r]) => !(r.ok && r.value.text === text)).map(([k]) => k).join(','));
  const asText = await new Response(bytes).text();
  ok('M. …and that is identical to what Response.text() produces for the same bytes', asText === text && results[1].value?.text === asText);
  ok('M. no replacement characters were introduced at chunk boundaries', results[1].ok && results[3].ok && !results[1].value.text.includes('\uFFFD') && !results[3].value.text.includes('\uFFFD'));
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<html>é</html>', 'utf8')]);
  const bomR = await stubbed(splitAt(bom, 2)), bomRef = await new Response(bom).text();
  ok('M. a leading UTF-8 BOM is dropped exactly as Response.text() drops it (even when it is split across chunks)', bomR.ok && bomR.value.text === bomRef && !bomR.value.text.startsWith('\uFEFF'));
  const broken = Buffer.from([0x61, 0xff, 0x62, 0xe2, 0x82]);   // an invalid byte, and a character cut off at the end of the body
  const brokenR = await stubbed(splitAt(broken, 2)), brokenRef = await new Response(broken).text();
  ok('M. invalid / truncated UTF-8 is replaced exactly as Response.text() replaces it', brokenR.ok && brokenR.value.text === brokenRef, JSON.stringify([brokenR.value?.text, brokenRef]));
  const empty = await stubbed([]);
  ok('M. an empty body is the empty string (not null: the body WAS read)', empty.ok && empty.value.text === '');

  // …and over a real socket, with the multi-byte characters delivered a few bytes at a time
  const s = await serve(async (req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); for (let o = 0; o < bytes.length; o += 5) { res.write(bytes.subarray(o, o + 5)); await sleep(1); } res.end(); });
  const net = await attempt(() => fetchBounded(`${s.base}/`, { timeoutMs: 8000, maxBytes: htmlMaxBytes(), readBody: () => true }), 12000);
  ok('M. over a real socket, multi-byte characters trickled a few bytes at a time decode correctly', net.ok && net.value.text === text, JSON.stringify(net).slice(0, 120));
  s.close();
}

/* ═════════ N. cancellation, resource release and timer cleanup ═════════ */
{
  const s = await serve((req, res, st) => {
    if (req.url === '/robots.txt' || req.url === '/sitemap.xml') { res.writeHead(404); return res.end(); }
    if (req.url === '/video') return endless(res, 'video/mp4', 'fake-video');
    if (req.url === '/ok') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(html('Fine')); }
    if (req.url === '/drip') return drip(res, 'text/html', '<html><body>');
    res.writeHead(404); res.end();
  });
  const v = await attempt(() => crawlWebsite(`${s.base}/video`, { maxPages: 1, maxDepth: 0, requestTimeoutMs: 3000, crawlDelayMs: 0 }), 8000);
  ok('N. a non-HTML response that never ends is not read, and the crawl finishes at once (it is recorded by its content type)', !v.hung && v.ok && v.value.pages[0].contentType === 'video/mp4' && v.value.pages[0].error === null && v.ms < 3000, JSON.stringify(v).slice(0, 160));
  ok('N. …and that unread response is cancelled rather than left open for ever (the server sees the connection close)', await until(() => s.reqs.find((r) => r.path === '/video')?.closed === true) && s.reqs.find((r) => r.path === '/video').finished === false);

  // the deadline timer is always cleaned up: success, timeout, oversize, 404, and a body that is not wanted
  const real = { set: globalThis.setTimeout, clear: globalThis.clearTimeout };
  const live = new Set(); let created = 0;
  globalThis.setTimeout = (fn, ms, ...a) => { const h = real.set(fn, ms, ...a); if (ms === 31337) { live.add(h); created++; } return h; };
  globalThis.clearTimeout = (h) => { live.delete(h); return real.clear(h); };
  try {
    const run = (path, over = {}) => attempt(() => fetchBounded(`${s.base}${path}`, { timeoutMs: 31337, maxBytes: htmlMaxBytes(), readBody: () => true, ...over }), 8000);
    const leaks = {};
    await run('/ok'); leaks.success = live.size;
    await run('/ok', { readBody: () => false }); leaks.unwanted = live.size;
    await run('/missing'); leaks.notFound = live.size;
    await run('/video', { maxBytes: 100_000 }); leaks.oversize = live.size;
    const failing = await attempt(() => fetchBounded('http://127.0.0.1:1/', { timeoutMs: 31337, maxBytes: 1000 }), 8000); leaks.connectionRefused = live.size;
    ok('N. the deadline timer is cleared on every exit path — success, unwanted body, 404, oversize, and a refused connection (a refused connection is still reported as an ordinary error)', created === 5 && Object.values(leaks).every((n) => n === 0) && failing.ok === false && !(failing.error instanceof RequestTimeoutError), JSON.stringify({ created, leaks, err: failing.error?.message }));
  } finally { globalThis.setTimeout = real.set; globalThis.clearTimeout = real.clear; }
  s.close();
}
{
  const s = await serve((req, res) => { if (req.url === '/') return drip(res, 'text/html', '<html><body>'); res.writeHead(404); res.end(); });
  const real = { set: globalThis.setTimeout, clear: globalThis.clearTimeout };
  const live = new Set();
  globalThis.setTimeout = (fn, ms, ...a) => { const h = real.set(fn, ms, ...a); if (ms === 1234) live.add(h); return h; };
  globalThis.clearTimeout = (h) => { live.delete(h); return real.clear(h); };
  let r;
  try { r = await attempt(() => fetchBounded(`${s.base}/`, { timeoutMs: 1234, maxBytes: htmlMaxBytes(), readBody: () => true }), 10000); } finally { globalThis.setTimeout = real.set; globalThis.clearTimeout = real.clear; }
  ok('N. a deadline that actually FIRES (a stalled body) is cleaned up as well — nothing is left pending', timeoutKinds(r) && live.size === 0, `${live.size} ${JSON.stringify(r).slice(0, 100)}`);
  s.close();
}

/* ═════════ O. a bad page does not stop the crawl ═════════ */
async function badPageSite() {
  return serve((req, res) => {
    if (req.url === '/robots.txt' || req.url === '/sitemap.xml') { res.writeHead(404); return res.end(); }
    if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(html('Home', '<a href="/big">big</a><a href="/drip">drip</a><a href="/ok">ok</a>')); }
    if (req.url === '/big') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(bytesOfHtml(200_000)); }
    if (req.url === '/drip') return drip(res, 'text/html', '<html><head><title>never</title></head><body>');
    if (req.url === '/ok') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(html('Perfectly Fine Page')); }
    res.writeHead(404); res.end();
  });
}
const SMALL_ENV = { SEO_HTML_MAX_BYTES: '50000', SEO_REQUEST_TIMEOUT_MS: '400', SEO_CRAWL_DELAY_MS: '1', SEO_MAX_PAGES: '10', SEO_MAX_DEPTH: '3' };
{
  const s = await badPageSite();
  const r = await withEnv(SMALL_ENV, () => attempt(() => crawlWebsite(s.base, { ...crawlLimits() }), 8000));
  const byPath = (p) => r.value?.pages.find((x) => x.url === `${s.base}${p}`);
  ok('O. one page over the cap, one that stalls, one fine: the crawl FINISHES (it does not hang) and visits all four pages', !r.hung && r.ok && r.value.pages.length === 4 && r.ms < 10000, JSON.stringify(r).slice(0, 160));
  ok('O. …the oversized page is a page error with the deterministic message and no status code (the existing page-error path)', byPath('/big')?.error === 'response body exceeds maximum size' && byPath('/big').statusCode == null);
  ok('O. …the stalled page is a page error "timed out after 400ms"', byPath('/drip')?.error === 'timed out after 400ms' && byPath('/drip').statusCode == null);
  ok('O. …and the valid page that comes AFTER the failures was still crawled normally', byPath('/ok')?.title === 'Perfectly Fine Page' && byPath('/ok').statusCode === 200 && byPath('/ok').error === null);
  ok('O. …both failures are in the crawl\'s errors list', r.value?.errors?.length === 2 && r.value.errors.some((e) => e.error === 'response body exceeds maximum size') && r.value.errors.some((e) => e.error === 'timed out after 400ms'));
  s.close();
}

/* ═════════ P. the full executeScan() path on SQLite and on the PostgreSQL adapter ═════════ */
{
  const { createStore } = await import(new URL('./db.js', import.meta.url).href);
  const { executeScan } = await import(new URL('./seo/jobs.js', import.meta.url).href);
  const dbFile = join(tmpdir(), 'hk-bounded-fetch-test.db');
  for (const x of ['', '-wal', '-shm']) rmSync(dbFile + x, { force: true });
  process.env.SQLITE_PATH = dbFile;
  const sqliteStore = await createStore();
  const { Pool } = newDb().adapters.createPg();
  const pgStore = await createStore({ pool: new Pool() });
  ok('P. the second backend really is the PostgreSQL adapter (pg-mem)', pgStore.kind === 'postgres');

  for (const [label, store] of [['sqlite', sqliteStore], ['pg-mem', pgStore]]) {
    const s = await badPageSite();
    const site = await store.ensureWebsite(s.host, `bounded-${label}`);
    const audit = await store.createAuditIfNoneActive(site.id, { baseUrl: `${s.base}/`, pagesPlanned: 10 });
    const run = await withEnv(SMALL_ENV, () => attempt(() => executeScan(store, site.id, audit.id, `${s.base}/`), 12000));
    const done = await store.getAudit(audit.id);
    ok(`P. [${label}] executeScan over a site with an oversized page and a stalled page RETURNS (it does not hang) and the audit reaches its normal terminal state`, !run.hung && run.ok && done.status === 'complete' && done.finished_at != null && typeof done.score === 'number', JSON.stringify({ run: run.hung ? 'hung' : run.ok, status: done.status }));
    ok(`P. [${label}] …the two fetch failures went through the existing error path: errors_count 2, all 4 pages counted, summary says so`, done.errors_count === 2 && done.pages_crawled === 4 && /4 page\(s\) crawled/.test(done.summary), JSON.stringify({ e: done.errors_count, p: done.pages_crawled, s: done.summary }));
    const pages = await store.listPages(site.id), byUrl = (p) => pages.find((x) => x.url === `${s.base}${p}`);
    ok(`P. [${label}] …the good page was stored with its facts; the failed ones were stored without a status code (nothing was stored as if it had succeeded)`, byUrl('/ok')?.title === 'Perfectly Fine Page' && byUrl('/ok').status_code === 200 && byUrl('/big')?.status_code === null && byUrl('/drip')?.status_code === null, JSON.stringify(pages.map((p) => [p.url.replace(s.base, ''), p.status_code, p.title])));

    // the START page itself stalls: the audit must still end, not stay 'running'
    const dripSite = await serve((req, res) => { if (req.url === '/') return drip(res, 'text/html', '<html><head><title>never</title></head><body>'); res.writeHead(404); res.end(); });
    const site2 = await store.ensureWebsite(dripSite.host, `bounded-start-${label}`);
    const audit2 = await store.createAuditIfNoneActive(site2.id, { baseUrl: `${dripSite.base}/`, pagesPlanned: 10 });
    const run2 = await withEnv(SMALL_ENV, () => attempt(() => executeScan(store, site2.id, audit2.id, `${dripSite.base}/`), 12000));
    const done2 = await store.getAudit(audit2.id);
    ok(`P. [${label}] when the START page stalls the audit still ends (status ${done2.status}, not "running"), and the stalled fetch is counted as a crawl error`, !run2.hung && run2.ok && done2.status !== 'running' && done2.status !== 'queued' && done2.errors_count >= 1, JSON.stringify({ run2: run2.hung ? 'hung' : run2.ok, status: done2.status, errors: done2.errors_count }));
    s.close(); dripSite.close();
  }
  await sqliteStore.close(); await pgStore.close();
  for (const x of ['', '-wal', '-shm']) { try { rmSync(dbFile + x, { force: true }); } catch { /* best effort */ } }
}

/* ═════════ S. scope and wiring proofs (source inspection, this repository's established convention) ═════════ */
{
  // Comments only: a block comment starts a line, a line comment follows whitespace — so a string such as 'text/html,*/*' or 'https://…' is never mistaken for one.
  const strip = (code) => code.replace(/(^|\n)[ \t]*\/\*[\s\S]*?\*\//g, '$1').replace(/(^|[ \t;{}])\/\/.*$/gm, '$1');
  const httpSrc = src('./seo/http.js'), httpCode = strip(httpSrc);
  const crawlerCode = strip(src('./seo/crawler.js')), robotsCode = strip(src('./seo/robots.js')), sitemapCode = strip(src('./seo/sitemap.js'));
  const files = [];
  for (const dir of ['.', './seo', './admin']) for (const f of readdirSync(fileURLToPath(new URL(dir + '/', import.meta.url)))) if (/\.(js|mjs)$/.test(f) && !f.startsWith('test-')) files.push(`${dir}/${f}`);
  const users = (needle) => files.filter((f) => strip(src(f)).includes(needle)).sort().join(',');

  ok('S. the unbounded fetchWithTimeout() no longer exists anywhere in production code', users('fetchWithTimeout') === '', users('fetchWithTimeout'));
  ok('S. the only production users of fetchBounded are the crawler, robots.txt and sitemap code (plus its own definition)', users('fetchBounded') === './seo/crawler.js,./seo/http.js,./seo/robots.js,./seo/sitemap.js', users('fetchBounded'));
  for (const [name, code] of [['crawler.js', crawlerCode], ['robots.js', robotsCode], ['sitemap.js', sitemapCode]]) {
    ok(`S. ${name} reaches the network only through fetchBounded: no fetch(), no .text(), no direct body access`, (code.match(/fetchBounded\(/g) || []).length === 1 && !/(^|[^.\w])fetch\s*\(/.test(code) && !/\.text\s*\(\)|\.body\b|\.arrayBuffer\s*\(|\.json\s*\(/.test(code), '');
  }
  ok('S. each resource names its OWN cap at the call site: HTML crawl -> htmlMaxBytes(), robots -> robotsMaxBytes(), sitemap -> sitemapMaxBytes() — and none reaches for another\'s', /maxBytes: htmlMaxBytes\(\)/.test(crawlerCode) && !/robotsMaxBytes|sitemapMaxBytes/.test(crawlerCode) && /maxBytes: robotsMaxBytes\(\)/.test(robotsCode) && !/htmlMaxBytes|sitemapMaxBytes/.test(robotsCode) && /maxBytes: sitemapMaxBytes\(\)/.test(sitemapCode) && !/htmlMaxBytes|robotsMaxBytes/.test(sitemapCode));
  ok('S. the deadline timer aborts the request, and is cleared in exactly one place — the finally block, i.e. never before the body has been read', /setTimeout\(\(\) => \{ timedOut = true; controller\.abort\(\); \}, timeoutMs\)/.test(httpCode) && (httpCode.match(/clearTimeout/g) || []).length === 1 && /finally \{\s*clearTimeout\(timer\);/.test(httpCode));
  ok('S. the body is read incrementally (getReader) and counted as it arrives, with no whole-body read and no cap that depends on Content-Length alone', /getReader\(\)/.test(httpCode) && /received \+= value\.byteLength/.test(httpCode) && /received > maxBytes/.test(httpCode) && !/\.text\s*\(\)|\.arrayBuffer\s*\(|\.json\s*\(/.test(httpCode));
  ok('S. decoding is one streaming UTF-8 decoder (stream: true, flushed at the end), not one decode per chunk', /new TextDecoder\('utf-8'\)/.test(httpCode) && /decoder\.decode\(value, \{ stream: true \}\)/.test(httpCode) && /decoder\.decode\(\)/.test(httpCode));
  ok('S. a failed, oversized or deliberately unread response is aborted (its socket closed) in the finally block', /if \(!bodyDone\) controller\.abort\(\);/.test(httpCode));
  const envNames = [...new Set(files.flatMap((f) => strip(src(f)).match(/SEO_[A-Z_]*BYTES/g) || []))].sort().join(',');
  ok('S. exactly the three approved environment variables exist for sizes — no global one', envNames === 'SEO_HTML_MAX_BYTES,SEO_ROBOTS_MAX_BYTES,SEO_SITEMAP_MAX_BYTES', envNames);
  ok('S. the sitemap fetch cap is untouched (const MAX_SITEMAPS = 15;) — the stale-threshold drift guard still finds it', /const MAX_SITEMAPS = 15;/.test(src('./seo/sitemap.js')));
  ok('S. limits.js is untouched by this step: still exactly four crawl limits, no size limits, and staleAuditMs() is unchanged (30 minutes at the defaults)', Object.keys(crawlLimits()).sort().join() === 'crawlDelayMs,maxDepth,maxPages,requestTimeoutMs' && !/BYTES/i.test(src('./seo/limits.js')) && staleAuditMs() === 30 * 60_000);
  ok('S. the other outbound calls keep their own, separate timeout handling: PageSpeed, the LLM provider and Google OAuth do not use the crawler helper', ['./seo/pagespeed.js', './seo/llm.js', './google.js'].every((f) => !/fetchBounded|from '\.\/http\.js'/.test(src(f))));
  ok('S. no specialist, recommendation, stale-audit, verification or authorization code was touched: none of it references the bounded-fetch API', ['./seo/specialistIntegration.js', './seo/orchestrator.js', './seo/specialistRecommendationConverter.js', './seo/jobs.js', './seo/routes.js', './seo/apply.js', './auth.js', './app.js', './db.js'].every((f) => !/fetchBounded|MaxBytes|MAX_BYTES|RequestTimeoutError|ResponseTooLargeError/.test(src(f))));
}

for (const e of servers) e.close();
ok('no unhandled promise rejection happened anywhere in this suite (aborting streams cleanly)', unhandled.length === 0, unhandled.map((e) => String(e?.message || e)).join(' | '));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
