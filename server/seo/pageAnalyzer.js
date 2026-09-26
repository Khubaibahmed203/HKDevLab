/**
 * Turns one crawlWebsite() result into SEOIssue-shaped findings — technical, on-page, duplicate-content and
 * internal-link-graph checks, all deterministic (no LLM). This is the Phase 2 analyzer; it works over an
 * arbitrary set of crawled pages instead of the one hand-known homepage server/seo/analyzers.js (Phase 1)
 * still checks — that file is untouched and still used by its own tests, this one is new.
 */
const issue = (type, severity, detail, recommendation = null, pageUrl = null) => ({ type, severity, detail, recommendation, pageUrl });

export function analyzePages(crawl) {
  const { pages, links, robots, sitemaps, allowedHost } = crawl;
  const issues = [];
  const startUrl = pages[0]?.url;
  const htmlPages = pages.filter((p) => !p.disallowedByRobots && !p.error && p.statusCode != null && /text\/html/i.test(p.contentType || ''));

  /* ---- crawlability ---- */
  if (!robots.exists) issues.push(issue('missing-robots-txt', 'critical', 'robots.txt is missing or unreachable.', 'Add a robots.txt file.'));
  const disallowedStart = pages.find((p) => p.disallowedByRobots && p.url === startUrl);
  if (disallowedStart) issues.push(issue('robots-disallow', 'critical', `${startUrl} is disallowed by robots.txt.`, 'Check robots.txt does not block pages you want indexed.', startUrl));

  const okSitemaps = sitemaps.filter((s) => !s.error);
  if (!okSitemaps.length) issues.push(issue('missing-sitemap', 'critical', 'No reachable sitemap.xml was found.', 'Add a sitemap.xml file.'));
  for (const sm of sitemaps.filter((s) => s.error)) issues.push(issue('sitemap-error', 'warning', `Sitemap ${sm.url} could not be read: ${sm.error}`, 'Fix or remove the broken sitemap reference.'));
  for (const sm of okSitemaps) for (const e of sm.entries) {
    try { if (new URL(e.loc).host.toLowerCase() !== allowedHost.toLowerCase()) issues.push(issue('sitemap-external-url', 'warning', `Sitemap lists a URL outside ${allowedHost}: ${e.loc}`, 'Remove URLs for other domains from the sitemap.')); } catch { /* not a URL — ignore */ }
  }
  const sitemapUrls = new Set(okSitemaps.flatMap((s) => s.entries.map((e) => e.loc)));
  for (const p of htmlPages) {
    if (p.statusCode === 200 && !/noindex/i.test(p.robotsMeta || '') && !sitemapUrls.has(p.finalUrl) && !sitemapUrls.has(p.url)) {
      issues.push(issue('missing-from-sitemap', 'info', `${p.url} was crawled but is not listed in the sitemap.`, 'Add it to sitemap.xml if it should be discoverable.', p.url));
    }
  }

  /* ---- per-page technical + on-page checks ---- */
  const titleMap = new Map(), descMap = new Map(), contentHashMap = new Map();
  for (const p of htmlPages) {
    if (p.statusCode >= 400) issues.push(issue('broken-page', 'critical', `${p.url} returned HTTP ${p.statusCode}.`, 'Fix or remove the broken page.', p.url));
    if (p.statusCode >= 300 && p.statusCode < 400) issues.push(issue('redirect', 'info', `${p.url} redirects to ${p.finalUrl}.`, null, p.url));
    let finalHost = null; try { finalHost = new URL(p.finalUrl).host; } catch { /* noop */ }
    if (finalHost && finalHost.toLowerCase() !== allowedHost.toLowerCase()) issues.push(issue('redirects-external', 'warning', `${p.url} redirects to a different domain (${p.finalUrl}).`, 'Confirm this is intentional.', p.url));
    if (!/^https:$/i.test(new URL(p.finalUrl).protocol)) issues.push(issue('not-https', 'critical', `${p.finalUrl} is not served over HTTPS.`, 'Serve the page over HTTPS.', p.url));

    if (!p.title) issues.push(issue('missing-title', 'critical', `${p.url} has no <title>.`, 'Add a page title.', p.url));
    else if (p.title.length < 15 || p.title.length > 60) issues.push(issue('title-length', 'warning', `${p.url} title is ${p.title.length} characters.`, 'Aim for roughly 15–60 characters.', p.url));
    if (p.title) titleMap.set(p.title.trim().toLowerCase(), [...(titleMap.get(p.title.trim().toLowerCase()) || []), p.url]);

    if (!p.description) issues.push(issue('missing-description', 'critical', `${p.url} has no meta description.`, 'Add a meta description.', p.url));
    else if (p.description.length < 50 || p.description.length > 160) issues.push(issue('description-length', 'warning', `${p.url} description is ${p.description.length} characters.`, 'Aim for roughly 50–160 characters.', p.url));
    if (p.description) descMap.set(p.description.trim().toLowerCase(), [...(descMap.get(p.description.trim().toLowerCase()) || []), p.url]);

    if (p.contentHash) contentHashMap.set(p.contentHash, [...(contentHashMap.get(p.contentHash) || []), p.url]);

    if (!p.canonical) issues.push(issue('missing-canonical', 'critical', `${p.url} has no canonical tag.`, 'Add a canonical tag.', p.url));
    else { let h = null; try { h = new URL(p.canonical, p.finalUrl).host; } catch { /* noop */ } if (h && h.toLowerCase() !== allowedHost.toLowerCase()) issues.push(issue('canonical-cross-domain', 'warning', `${p.url} canonical points to a different domain (${p.canonical}).`, 'Confirm this is intentional.', p.url)); }

    if (/noindex/i.test(p.robotsMeta || '')) issues.push(issue('noindex', 'warning', `${p.url} has a noindex directive.`, 'Confirm this page is meant to be excluded from search results.', p.url));
    if (!p.lang) issues.push(issue('missing-lang', 'info', `${p.url} has no lang attribute on <html>.`, 'Add a lang attribute to <html>.', p.url));
    if (!p.hasViewport) issues.push(issue('missing-viewport', 'warning', `${p.url} has no viewport meta tag.`, 'Add a responsive viewport meta tag.', p.url));

    if (p.h1Count === 0) issues.push(issue('missing-h1', 'critical', `${p.url} has no <h1>.`, 'Add a single <h1>.', p.url));
    else if (p.h1Count > 1) issues.push(issue('multiple-h1', 'warning', `${p.url} has ${p.h1Count} <h1> tags.`, 'Use a single <h1>.', p.url));
    for (let i = 1; i < (p.headingLevels || []).length; i++) { if (p.headingLevels[i] - p.headingLevels[i - 1] > 1) { issues.push(issue('heading-hierarchy-skip', 'info', `${p.url} skips a heading level.`, 'Avoid skipping heading levels.', p.url)); break; } }
    if (p.sectionsWithoutHeading) issues.push(issue('section-missing-heading', 'info', `${p.url}: ${p.sectionsWithoutHeading} <section> element(s) have no heading.`, 'Give every section a heading (a visually hidden one is fine).', p.url));

    if (p.missingAltCount) issues.push(issue('missing-alt', 'warning', `${p.url}: ${p.missingAltCount} of ${p.images?.length || 0} images have no alt attribute.`, 'Add descriptive alt text to content images.', p.url));
    if (!p.jsonLdPresent) issues.push(issue('missing-json-ld', 'info', `${p.url} has no structured data.`, 'Consider adding a JSON-LD block.', p.url));
    else if (!p.jsonLdValid) issues.push(issue('invalid-json-ld', 'critical', `${p.url} has invalid JSON-LD.`, 'Fix the JSON-LD syntax — it currently fails to parse.', p.url));
    if (p.duplicateIds) issues.push(issue('duplicate-ids', 'info', `${p.url} has ${p.duplicateIds} duplicate id attribute(s).`, 'Ensure every id on the page is unique.', p.url));
    if (p.wordCount != null && p.wordCount < 50) issues.push(issue('thin-content', 'warning', `${p.url} has only about ${p.wordCount} words of visible text.`, 'Consider adding more substantive content.', p.url));
  }

  for (const [, urls] of titleMap) if (urls.length > 1) issues.push(issue('duplicate-title', 'warning', `${urls.length} pages share the same title: ${urls.join(', ')}`, 'Give each page a unique, descriptive title.'));
  for (const [, urls] of descMap) if (urls.length > 1) issues.push(issue('duplicate-description', 'warning', `${urls.length} pages share the same meta description: ${urls.join(', ')}`, 'Give each page a unique description.'));
  for (const [, urls] of contentHashMap) if (urls.length > 1) issues.push(issue('duplicate-content', 'warning', `${urls.length} pages have near-identical visible content: ${urls.join(', ')}`, 'Differentiate the content or canonicalize one page as the source.'));

  /* ---- internal link graph ---- */
  const internalLinks = links.filter((l) => l.isInternal);
  const inCounts = new Map();
  for (const l of internalLinks) inCounts.set(l.toUrl, (inCounts.get(l.toUrl) || 0) + 1);
  for (const p of htmlPages) {
    if (p.url !== startUrl && !inCounts.get(p.url)) issues.push(issue('orphan-page', 'warning', `${p.url} has no internal links pointing to it from the pages that were crawled.`, 'Link to this page from somewhere else on the site.', p.url));
  }
  const byUrl = new Map(pages.map((p) => [p.url, p]));
  for (const l of internalLinks) {
    const target = byUrl.get(l.toUrl);
    if (!target) continue;
    if (target.statusCode >= 400) issues.push(issue('broken-internal-link', 'warning', `${l.fromUrl} links to ${l.toUrl}, which returns ${target.statusCode}.`, 'Fix or remove the link.', l.fromUrl));
    else if (target.statusCode >= 300 && target.statusCode < 400) issues.push(issue('link-to-redirect', 'info', `${l.fromUrl} links to ${l.toUrl}, which redirects to ${target.finalUrl}.`, 'Point the link at the final URL directly.', l.fromUrl));
  }

  return issues;
}
