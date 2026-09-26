/** The crawler's fetch wrapper: a fixed User-Agent (so a site owner can identify and block it in robots.txt)
 *  and a hard timeout via AbortController, since native fetch has no built-in one. */
export const CRAWLER_USER_AGENT = 'HKDevLabSEOAgent/1.0 (+https://hkdevlab.com)';

export async function fetchWithTimeout(url, { timeoutMs = 10000, userAgent = CRAWLER_USER_AGENT, redirect = 'follow' } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { redirect, signal: controller.signal, headers: { 'User-Agent': userAgent, Accept: 'text/html,application/xhtml+xml,*/*' } });
  } finally {
    clearTimeout(timer);
  }
}
