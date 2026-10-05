import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import { normalizeWebUrl } from '../content/schema.js';

/**
 * "Can this website be shown inside an <iframe> on our pages?" — answered from the site's own response headers
 * (X-Frame-Options and the CSP `frame-ancestors` directive). A browser never tells a page whether a cross-origin frame
 * was refused (it just stays blank), so this is the only reliable way to know. We only READ what the site says;
 * nothing here tries to get around it.
 *
 * Because OUR server fetches an address an editor typed, it must never be usable to reach our own network:
 *   • https only, port 443, and only the response HEADERS are read (the body is never downloaded)
 *   • the address is checked at connect time (see safeLookup), so a DNS trick can't swap in a private one
 *   • loopback, private, link-local, carrier-grade-NAT and other reserved ranges are refused
 *   • a few redirects are followed, each re-checked; short overall timeout
 */

const BLOCKED = new net.BlockList();
for (const [a, p] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]]) BLOCKED.addSubnet(a, p, 'ipv4');
// (an IPv4-mapped IPv6 address, ::ffff:a.b.c.d, is NOT listed here: Node matches plain IPv4 addresses against such a rule, which would refuse every address)
for (const [a, p] of [['::', 128], ['::1', 128], ['64:ff9b::', 96], ['100::', 64], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) BLOCKED.addSubnet(a, p, 'ipv6');

/** true for anything that is not an ordinary public internet address */
export function isBlockedAddress(ip) {
  const v = net.isIP(ip);
  if (!v) return true;
  if (v === 6) {                                                              // ::ffff:127.0.0.1 and ::ffff:7f00:1 are just IPv4 addresses in disguise
    const m = /^::ffff:(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/i.exec(ip);
    if (m) return isBlockedAddress(m[1] || [parseInt(m[2], 16) >> 8, parseInt(m[2], 16) & 255, parseInt(m[3], 16) >> 8, parseInt(m[3], 16) & 255].join('.'));
  }
  return BLOCKED.check(ip, v === 4 ? 'ipv4' : 'ipv6');
}

// Used as the socket's DNS lookup, so the address that is actually connected to is the one that was checked.
function safeLookup(hostname, options, cb) {
  if (typeof options === 'function') { cb = options; options = {}; }
  dns.lookup(hostname, { all: true, verbatim: true }, (err, addrs) => {
    if (err) return cb(err);
    if (!addrs.length || addrs.some((a) => isBlockedAddress(a.address))) return cb(Object.assign(new Error('address not allowed'), { code: 'EBLOCKED' }));
    if (options && options.all) return cb(null, addrs);
    cb(null, addrs[0].address, addrs[0].family);
  });
}

/* ───────────── what the site's headers say about being framed ───────────── */

// every `frame-ancestors` source list found in the Content-Security-Policy header(s)
function frameAncestors(csp) {
  const lists = [];
  for (const policy of String(csp || '').split(',')) {
    for (const directive of policy.split(';')) {
      const [name, ...sources] = directive.trim().split(/\s+/);
      if (name && name.toLowerCase() === 'frame-ancestors') lists.push(sources);
    }
  }
  return lists;
}

// does a frame-ancestors source list let a page at `origin` embed the site?
function allowsOrigin(sources, origin) {
  if (!sources.length) return false;                                          // an empty list means 'none'
  let o = null;
  try { o = new URL(origin); } catch { /* unknown origin: only * can match */ }
  return sources.some((raw) => {
    const t = raw.replace(/^'|'$/g, '').toLowerCase();
    if (t === '*') return true;
    if (t === 'none' || t === 'self' || !o) return false;                   // 'self' is the SITE'S origin, never ours
    if (t.endsWith(':')) return o.protocol === t;                           // a scheme source, e.g. https:
    const m = /^(?:([a-z][a-z0-9+.-]*):\/\/)?(\*\.)?([a-z0-9.-]+)(?::(\d+|\*))?(?:\/.*)?$/.exec(t);
    if (!m) return false;
    const [, scheme, wild, host, port] = m;
    if (scheme && o.protocol !== `${scheme}:`) return false;
    if (port && port !== '*' && port !== (o.port || (o.protocol === 'https:' ? '443' : '80'))) return false;
    return wild ? o.hostname.endsWith(`.${host}`) : o.hostname === host;
  });
}

/**
 * Verdict for a response's headers, for a page served from `origin`.
 * Like browsers: when a CSP frame-ancestors directive exists it decides and X-Frame-Options is ignored; otherwise X-Frame-Options decides.
 * → { embeddable: boolean, reason }
 */
export function framingVerdict(headers, origin = '') {
  const lists = frameAncestors([].concat(headers['content-security-policy'] || []).join(','));
  if (lists.length) return lists.every((s) => allowsOrigin(s, origin)) ? { embeddable: true, reason: 'csp-allows' } : { embeddable: false, reason: 'csp-frame-ancestors' };
  const xfo = String(headers['x-frame-options'] || '').trim().toLowerCase();
  if (xfo && xfo !== 'allowall') return { embeddable: false, reason: 'x-frame-options' };   // DENY, SAMEORIGIN, or the obsolete ALLOW-FROM
  return { embeddable: true, reason: 'no-restriction' };
}

/* ───────────── the check itself ───────────── */

const UA = 'Mozilla/5.0 (compatible; HKDevLab-preview-check/1.0)';

function fetchHeaders(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'GET', agent: false, lookup: safeLookup, timeout: timeoutMs,
      headers: { 'user-agent': UA, accept: 'text/html,*/*;q=0.8', 'accept-language': 'en' },
    }, (res) => { res.destroy(); resolve({ status: res.statusCode, headers: res.headers }); });   // headers are all we want
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    req.end();
  });
}

const failure = (reason, extra = {}) => ({ ok: false, reason, ...extra });

/**
 * probeEmbed(url, { origin }) →
 *   { ok: true,  embeddable, reason, status, host, finalUrl }   we reached the site and read what it says about framing
 *   { ok: false, reason, status? }                              invalid · port · blocked-address · timeout · not-found · tls · status · unreachable
 * (a plain http:// address is { ok: true, embeddable: false, reason: 'http' } without any request: browsers refuse to show
 *  an http page inside our https page)
 */
export async function probeEmbed(raw, { origin = '', timeoutMs = 8000 } = {}) {
  const start = normalizeWebUrl(raw);
  if (!start) return failure('invalid');
  let url = new URL(start);
  const deadline = Date.now() + timeoutMs;
  try {
    for (let hop = 0; hop < 5; hop++) {
      if (url.protocol === 'http:') return { ok: true, embeddable: false, reason: 'http', host: url.host, finalUrl: url.href };
      if (url.protocol !== 'https:') return failure('unreachable');
      if (url.port && url.port !== '443') return failure('port');
      const bare = url.hostname.replace(/^\[|\]$/g, '');
      if (net.isIP(bare) && isBlockedAddress(bare)) return failure('blocked-address');
      const left = deadline - Date.now();
      if (left <= 0) return failure('timeout');
      const r = await fetchHeaders(url, left);
      if (r.status >= 300 && r.status < 400 && r.headers.location) { url = new URL(r.headers.location, url); continue; }
      if (r.status >= 400) return failure('status', { status: r.status, host: url.host });
      return { ok: true, status: r.status, host: url.host, finalUrl: url.href, ...framingVerdict(r.headers, origin) };
    }
    return failure('unreachable');                                                // too many redirects
  } catch (e) {
    if (e.code === 'EBLOCKED') return failure('blocked-address');
    if (e.code === 'ETIMEDOUT' || e.code === 'ECONNRESET' && Date.now() >= deadline) return failure('timeout');
    if (e.code === 'ENOTFOUND' || e.code === 'EAI_AGAIN') return failure('not-found');
    if (/CERT|TLS|SSL|ERR_TLS/i.test(String(e.code))) return failure('tls');
    return failure('unreachable');                                                // never pass raw error text on
  }
}
