import dns from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * Destination policy for the crawler's REDIRECT hops (Phase 4 Hardening #10). A site being audited can answer any request with a redirect, and
 * fetch() would follow it anywhere — loopback, a private network, the cloud metadata address — so every hop is checked here BEFORE it is
 * requested (server/seo/http.js owns the redirect loop and calls this for each hop). The policy:
 *   • only http: and https:, and never a URL with embedded credentials;
 *   • a hop to the SAME host:port as the response that redirected is always allowed (the audited site itself, local development, the tests);
 *   • a hop to ANOTHER host must be a public unicast destination — which keeps the ordinary http→https and apex↔www redirects (and any other
 *     public redirect, still reported as an external redirect by the analyzer) working:
 *       - an IP literal must be a public address (the URL parser has already turned 127.1, 2130706433, 0x7f.1, octal and IPv4-mapped IPv6
 *         spellings into one canonical form, so this judges the address that would really be connected to, not the text that was written);
 *       - a name must not be localhost, *.localhost, a single label, or a reserved internal suffix;
 *       - and every address the name resolves to must be public.
 *
 * LIMITATION — read this before relying on it: the DNS step is a PRE-CHECK, not a defence against DNS rebinding. The name is resolved here
 * and then resolved AGAIN, independently, when the HTTP client connects; a DNS server that answers differently the second time defeats it, and
 * nothing here pins the connection to the address that was checked. It does stop the plain case — a hostname that always points at a private
 * address. Closing the rebinding gap needs connection-time address validation (a custom connector or HTTP client), which is deliberately not
 * part of this change.
 */

// [network address, prefix length]
const NON_PUBLIC_IPV4 = [
  ['0.0.0.0', 8],         // "this network" / unspecified
  ['10.0.0.0', 8],        // private (RFC 1918)
  ['100.64.0.0', 10],     // carrier-grade NAT
  ['127.0.0.0', 8],       // loopback
  ['169.254.0.0', 16],    // link-local — including the cloud metadata address 169.254.169.254
  ['172.16.0.0', 12],     // private (RFC 1918)
  ['192.0.0.0', 24],      // IETF protocol assignments
  ['192.0.2.0', 24],      // documentation (TEST-NET-1)
  ['192.88.99.0', 24],    // deprecated 6to4 relay anycast
  ['192.168.0.0', 16],    // private (RFC 1918)
  ['198.18.0.0', 15],     // benchmarking
  ['198.51.100.0', 24],   // documentation (TEST-NET-2)
  ['203.0.113.0', 24],    // documentation (TEST-NET-3)
  ['224.0.0.0', 4],       // multicast
  ['240.0.0.0', 4],       // reserved, including the 255.255.255.255 broadcast
];
const DOTTED_QUAD = /^\d{1,3}(\.\d{1,3}){3}$/;
const quadToNumber = (s) => s.split('.').reduce((n, octet) => n * 256 + Number(octet), 0);   // up to 2^32 - 1: exact in a double, no signed-shift traps

function ipv4IsPublic(addr) {
  if (!DOTTED_QUAD.test(addr) || addr.split('.').some((o) => Number(o) > 255)) return false;
  const n = quadToNumber(addr);
  return !NON_PUBLIC_IPV4.some(([base, bits]) => { const start = quadToNumber(base); return n >= start && n < start + 2 ** (32 - bits); });
}

/** Eight 16-bit groups of an IPv6 address (zone id dropped, "::" expanded, an embedded IPv4 tail turned into two groups) — or null. */
function ipv6Groups(addr) {
  let a = addr.split('%')[0].toLowerCase();
  if (a.includes('.')) {
    const cut = a.lastIndexOf(':'), tail = a.slice(cut + 1);
    if (!DOTTED_QUAD.test(tail)) return null;
    const o = tail.split('.').map(Number);
    if (o.some((n) => n > 255)) return null;
    a = `${a.slice(0, cut + 1)}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const halves = a.split('::');
  if (halves.length > 2) return null;
  const part = (s) => (s === '' ? [] : s.split(':'));
  const head = part(halves[0]), tail = halves.length === 2 ? part(halves[1]) : [];
  const gap = 8 - head.length - tail.length;
  if (halves.length === 2 ? gap < 1 : gap !== 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? gap : 0).fill('0'), ...tail];
  return groups.length === 8 && groups.every((g) => /^[0-9a-f]{1,4}$/.test(g)) ? groups.map((g) => parseInt(g, 16)) : null;
}

/** Public means global unicast (2000::/3) minus the special-purpose blocks inside it. Everything outside 2000::/3 is refused — loopback and
 *  unspecified (::1, ::), IPv4-mapped and IPv4-compatible (::ffff:a.b.c.d, ::a.b.c.d), NAT64, unique-local (fc00::/7), link-local (fe80::/10),
 *  multicast (ff00::/8) and the rest — so an IPv4 address can never be smuggled through an IPv6 spelling. */
function ipv6IsPublic(addr) {
  const g = ipv6Groups(addr);
  if (!g) return false;
  if ((g[0] & 0xe000) !== 0x2000) return false;
  if (g[0] === 0x2001 && g[1] < 0x0200) return false;      // 2001::/23 IETF protocol assignments (Teredo, ORCHID, ...)
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false;   // 2001:db8::/32 documentation
  if (g[0] === 0x2002) return false;                       // 2002::/16 6to4 (embeds an IPv4 address)
  if (g[0] === 0x3fff && g[1] < 0x1000) return false;      // 3fff::/20 documentation
  return true;
}

/** True only for a well-formed IPv4 or IPv6 address (brackets tolerated) that is a public unicast address. Anything else — including text that
 *  is not an address at all — is false. */
export function isPublicAddress(address) {
  let a = String(address ?? '').trim();
  if (a.startsWith('[') && a.endsWith(']')) a = a.slice(1, -1);
  const family = isIP(a);
  return family === 4 ? ipv4IsPublic(a) : family === 6 ? ipv6IsPublic(a) : false;
}

// Names that are never public destinations: the loopback name and the suffixes reserved for local or internal use (RFC 6761, 6762, 8375, and
// ICANN's .internal). A single label ("intranet", "metadata", "redis") is a local search-domain name, never a public site.
const NON_PUBLIC_SUFFIXES = ['localhost', 'local', 'localdomain', 'internal', 'home.arpa'];

/** False for localhost, *.localhost, a single-label name and the reserved internal suffixes — case-insensitively, and whether or not the name
 *  carries trailing dots ("localhost." is localhost). It says nothing about where a name POINTS; that is the resolution check. */
export function isPublicHostname(hostname) {
  const name = String(hostname ?? '').trim().toLowerCase().replace(/\.+$/, '');
  if (!name || !name.includes('.')) return false;
  return !NON_PUBLIC_SUFFIXES.some((suffix) => name === suffix || name.endsWith(`.${suffix}`));
}

/** Rejects when `signal` aborts first, so a stalled resolver can never outlive the request's deadline. */
function abortable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

const blocked = (reason) => ({ ok: false, reason });

/**
 * May the crawler follow a redirect from `from` (the URL that answered with the redirect) to `target` (the resolved Location, both URL objects)?
 * Resolves { ok: true }, or { ok: false, reason } — reason is one of: 'scheme', 'credentials', 'non-public-address', 'non-public-name',
 * 'resolves-non-public', 'unresolvable'. Never makes a request to `target`. `signal` bounds the name resolution; `lookup` replaces the system
 * resolver (tests). If `signal` aborts, the abort reason is thrown, so the caller's own deadline handling applies.
 */
export async function checkRedirectTarget(target, from, { signal, lookup } = {}) {
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return blocked('scheme');
  if (target.username || target.password) return blocked('credentials');
  if (from && target.host === from.host) return { ok: true };         // same host:port as the response that redirected — the audited site itself

  const host = target.hostname;
  const literal = host.startsWith('[') ? host.slice(1, -1) : host;
  if (isIP(literal)) return isPublicAddress(literal) ? { ok: true } : blocked('non-public-address');   // an address needs no resolution
  if (!isPublicHostname(host)) return blocked('non-public-name');

  let addresses;
  try { addresses = await abortable((lookup || dns.lookup)(host.replace(/\.+$/, ''), { all: true, verbatim: true }), signal); }
  catch (err) { if (signal?.aborted) throw err; return blocked('unresolvable'); }
  if (!Array.isArray(addresses) || !addresses.length) return blocked('unresolvable');
  return addresses.every((a) => isPublicAddress(a?.address)) ? { ok: true } : blocked('resolves-non-public');   // EVERY address must be public, not just the first
}
