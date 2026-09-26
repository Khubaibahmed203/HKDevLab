import { fetchWithTimeout } from './http.js';

/**
 * A safe, practical subset of robots.txt — not a full search-engine-grade implementation. Only the
 * wildcard (`User-agent: *`) group is honored; bot-specific groups are ignored, which is the conservative
 * choice (a site that is MORE restrictive for named bots than for everyone else is rare, and getting it
 * wrong in the other direction would mean crawling something the owner asked us not to).
 */
export function parseRobots(text) {
  const lines = String(text).split(/\r?\n/).map((l) => l.replace(/#.*/, '').trim()).filter(Boolean);
  const groups = [];
  const sitemaps = [];
  let current = null;
  for (const line of lines) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === 'user-agent') {
      if (current && current.rules.length) current = null;   // a rule line closes the group; a new UA line starts one
      if (!current) { current = { agents: [], rules: [] }; groups.push(current); }
      current.agents.push(value.toLowerCase());
    } else if (key === 'disallow' || key === 'allow') {
      if (current) current.rules.push({ type: key, path: value });
    } else if (key === 'sitemap' && value) {
      sitemaps.push(value);
    }
  }
  return { groups, sitemaps };
}

/** Longest-matching rule wins; an exact-length tie goes to Allow. An empty "Disallow:" means "allow everything". */
export function isAllowed(pathname, robots) {
  const group = robots?.groups?.find((g) => g.agents.includes('*'));
  if (!group) return true;
  let best = null;
  for (const rule of group.rules) {
    if (!rule.path) continue;
    if (!pathname.startsWith(rule.path)) continue;
    if (!best || rule.path.length > best.path.length || (rule.path.length === best.path.length && rule.type === 'allow')) best = rule;
  }
  return !best || best.type === 'allow';
}

export async function fetchRobots(origin, { timeoutMs, userAgent } = {}) {
  const url = `${origin}/robots.txt`;
  try {
    const res = await fetchWithTimeout(url, { timeoutMs, userAgent });
    if (!res.ok) return { url, exists: false, groups: [], sitemaps: [] };
    const text = await res.text();
    return { url, exists: true, ...parseRobots(text) };
  } catch {
    return { url, exists: false, groups: [], sitemaps: [] };
  }
}
