/**
 * Optional PageSpeed Insights lookup for the crawl's start URL. Server-side only (the key never reaches the
 * browser). With no PAGESPEED_API_KEY, this is a no-op that reports itself unavailable — never a fabricated
 * score. The crawler's own per-page response_time_ms is the "basic timing" fallback this stands in for.
 */
export async function fetchPageSpeed(url, { timeoutMs = 15_000 } = {}) {
  const key = process.env.PAGESPEED_API_KEY;
  if (!key) return { available: false, reason: 'PAGESPEED_API_KEY is not set' };

  const api = new URL('https://www.googleapis.com/pagespeedonline/v5/runPagespeed');
  api.searchParams.set('url', url);
  api.searchParams.set('key', key);
  api.searchParams.set('strategy', 'mobile');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(api, { signal: controller.signal });
    if (!res.ok) return { available: false, reason: `PageSpeed API error ${res.status}` };
    const data = await res.json();
    const perf = data?.lighthouseResult?.categories?.performance?.score;
    if (typeof perf !== 'number') return { available: false, reason: 'PageSpeed response had no performance score' };
    return { available: true, performanceScore: Math.round(perf * 100), fetchedAt: new Date().toISOString() };
  } catch (err) {
    return { available: false, reason: err.name === 'AbortError' ? 'timed out' : (err.message || 'request failed') };
  } finally {
    clearTimeout(timer);
  }
}
