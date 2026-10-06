import { checkRedirectTarget } from './ssrf.js';

/** The crawler's fetch wrapper: a fixed User-Agent (so a site owner can identify and block it in robots.txt),
 *  one hard deadline that covers the WHOLE request — connect, headers AND the response body — and a byte cap that is
 *  enforced on the bytes actually received, since native fetch has neither (its body can be read forever, and without limit).
 *  It also owns redirect handling: a redirect is followed here, one explicit hop at a time, and every hop is checked (see ssrf.js)
 *  before it is requested — so a site cannot use a redirect to make this server request a loopback, private or metadata address. */
export const CRAWLER_USER_AGENT = 'HKDevLabSEOAgent/1.0 (+https://hkdevlab.com)';

// The most redirects one request will follow: a chain of 10 redirects (11 requests) is followed, an 11th redirect is refused. Deliberately
// below the 20 the HTTP client would allow, and the only place this number lives.
export const MAX_REDIRECTS = 10;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

// Response-size caps, one per kind of resource. Each is an explicit per-resource limit that the call site names — there is
// deliberately no single global one — so an HTML crawl can never end up using the (much larger) sitemap allowance.
export const DEFAULT_HTML_MAX_BYTES = 5 * 1024 * 1024;        // 5 MiB = 5242880
export const DEFAULT_ROBOTS_MAX_BYTES = 1024 * 1024;          // 1 MiB = 1048576
export const DEFAULT_SITEMAP_MAX_BYTES = 10 * 1024 * 1024;    // 10 MiB = 10485760

// Read at call time, not at module load — the rest of this codebase's env vars follow the same rule (see server/seo/limits.js).
// An override must be a plain positive integer; anything else (unset, blank, zero, negative, fractional, "1e6", non-numeric,
// beyond the safe-integer range) falls back to the approved default — never to "no limit".
const positiveInt = (raw, fallback) => {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!/^[1-9]\d*$/.test(s)) return fallback;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : fallback;
};
export const htmlMaxBytes = () => positiveInt(process.env.SEO_HTML_MAX_BYTES, DEFAULT_HTML_MAX_BYTES);
export const robotsMaxBytes = () => positiveInt(process.env.SEO_ROBOTS_MAX_BYTES, DEFAULT_ROBOTS_MAX_BYTES);
export const sitemapMaxBytes = () => positiveInt(process.env.SEO_SITEMAP_MAX_BYTES, DEFAULT_SITEMAP_MAX_BYTES);

export class RequestTimeoutError extends Error {
  constructor(timeoutMs) { super('request timed out'); this.name = 'RequestTimeoutError'; this.code = 'REQUEST_TIMEOUT'; this.timeoutMs = timeoutMs; }
}
export class ResponseTooLargeError extends Error {
  constructor(maxBytes) { super('response body exceeds maximum size'); this.name = 'ResponseTooLargeError'; this.code = 'RESPONSE_TOO_LARGE'; this.maxBytes = maxBytes; }
}
export class TooManyRedirectsError extends Error {
  constructor(max) { super(`too many redirects (more than ${max})`); this.name = 'TooManyRedirectsError'; this.code = 'TOO_MANY_REDIRECTS'; this.maxRedirects = max; }
}
const BLOCKED_REDIRECT = {
  'invalid-location': 'its Location header is not a valid URL',
  scheme: 'only http and https URLs may be followed',
  credentials: 'the URL carries embedded credentials',
  'non-public-address': 'the destination is not a public address',
  'non-public-name': 'the destination is not a public host name',
  'resolves-non-public': 'the destination resolves to a non-public address',
  unresolvable: 'the destination could not be resolved',
};
/** A redirect that was refused BEFORE it was requested. `reason` is the machine-readable cause (see ssrf.js, plus 'invalid-location'). */
export class RedirectBlockedError extends Error {
  constructor(reason, target) {
    const where = target ? String(target.href ?? target).slice(0, 200) : null;
    super(`redirect ${where ? `to ${where} ` : ''}was blocked: ${BLOCKED_REDIRECT[reason] || reason}`);
    this.name = 'RedirectBlockedError'; this.code = 'REDIRECT_BLOCKED'; this.reason = reason; this.target = where;
  }
}

// fetch() hands header values over as a binary (latin-1) string, so a Location written in raw UTF-8 has to be decoded the way fetch's own
// redirect handling decodes it, or the same redirect would land on a different (double-encoded) URL.
const decodeLocation = (v) => (/[^\x00-\x7f]/.test(v) ? Buffer.from(v, 'latin1').toString('utf8') : v);

/**
 * GET `url` within ONE deadline (`timeoutMs`) that covers fetch -> response headers -> the whole body. When the deadline
 * passes, or the body outgrows `maxBytes`, the underlying request is ABORTED — the socket is closed, not merely ignored —
 * and a RequestTimeoutError / ResponseTooLargeError is thrown. A body is never returned truncated.
 *
 * `maxBytes` is required (a call that forgot it would otherwise be unbounded) and counts the DECODED bytes as they arrive,
 * so it holds when Content-Length is absent (chunked), wrong, or describes only a compressed size. A Content-Length that
 * already exceeds the cap is used as an early rejection, never as the only protection.
 *
 * `readBody(response)` decides, once the headers are in, whether the body is wanted at all; when it is not, the request is
 * cancelled instead of being left open. Resolves to { status, ok, url, headers, text, ttfbMs } — `text` is null when the body
 * was not read, and `ttfbMs` is the time until the headers arrived (what the crawler records as a page's response time).
 *
 * REDIRECTS (301, 302, 303, 307, 308) are followed here, never by fetch itself: each hop's Location is resolved against the URL that
 * returned it, checked by checkRedirectTarget() (ssrf.js) and only then requested; a refused hop makes NO request and throws
 * RedirectBlockedError, an 11th redirect throws TooManyRedirectsError. All hops share the one deadline above — it is never restarted per hop —
 * and the returned `url` is the final URL. The first `url` is the caller's own (the audited site) and is requested as given.
 */
export async function fetchBounded(url, { timeoutMs = 10000, maxBytes, userAgent = CRAWLER_USER_AGENT, readBody = () => true } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new TypeError('fetchBounded needs an explicit positive maxBytes');
  const controller = new AbortController();
  let timedOut = false, bodyDone = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const startedAt = Date.now();
  try {
    let res, current = url;
    for (let followed = 0; ; followed++) {
      res = await fetch(current, { redirect: 'manual', signal: controller.signal, headers: { 'User-Agent': userAgent, Accept: 'text/html,application/xhtml+xml,*/*' } });
      const location = REDIRECT_STATUSES.has(res.status) ? (res.headers.get('location') || '').trim() : '';
      if (!location) break;               // not a redirect — or one with no Location, which (as with fetch's own handling) is simply the response
      await res.body?.cancel().catch(() => {});   // a redirect's own body is never wanted: release its connection before the next request
      if (followed >= MAX_REDIRECTS) throw new TooManyRedirectsError(MAX_REDIRECTS);
      const from = new URL(res.url || current);
      let next;
      try { next = new URL(decodeLocation(location), from); } catch { throw new RedirectBlockedError('invalid-location'); }
      const verdict = await checkRedirectTarget(next, from, { signal: controller.signal });
      if (!verdict.ok) throw new RedirectBlockedError(verdict.reason, next);
      current = next.href;               // request exactly the URL that was validated, never the original text
    }
    const ttfbMs = Date.now() - startedAt;
    const text = readBody(res) ? await readBoundedText(res, maxBytes, controller) : null;
    bodyDone = text !== null;
    return { status: res.status, ok: res.ok, url: res.url, headers: res.headers, text, ttfbMs };
  } catch (err) {
    if (timedOut) throw new RequestTimeoutError(timeoutMs);
    throw err;
  } finally {
    clearTimeout(timer);
    if (!bodyDone) controller.abort();   // a failed, oversized or deliberately unread response must not keep its socket open
  }
}

/** Reads the body incrementally, counting the bytes actually received, and decodes it like Response.text() does (UTF-8,
 *  a leading BOM dropped, invalid sequences replaced) — but through ONE streaming decoder, so a multi-byte character that
 *  straddles two chunks is decoded whole instead of being corrupted at the boundary. */
async function readBoundedText(res, maxBytes, controller) {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new ResponseTooLargeError(maxBytes);
  if (!res.body) return '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  const parts = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) { controller.abort(); throw new ResponseTooLargeError(maxBytes); }
    parts.push(decoder.decode(value, { stream: true }));
  }
  parts.push(decoder.decode());
  return parts.join('');
}
