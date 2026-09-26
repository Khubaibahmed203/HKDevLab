/**
 * URL normalization and same-site checks — a "safe practical subset", not a full canonicalization spec:
 * lower-cases the host, drops the fragment (it's never sent to the server so it can't affect what page is
 * returned), drops a default port, and drops one trailing slash. Query strings are left as-is: stripping
 * them could silently merge genuinely different pages.
 */
export function normalizeUrl(raw, base) {
  let u;
  try { u = new URL(raw, base); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  u.hash = '';
  u.hostname = u.hostname.toLowerCase();
  if ((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443')) u.port = '';
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.slice(0, -1);
  return u.toString();
}

export function sameSite(url, allowedHost) {
  try { return new URL(url).host.toLowerCase() === String(allowedHost).toLowerCase(); } catch { return false; }
}
