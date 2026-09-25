/**
 * Deterministic, rule-based SEO checks — no LLM, no network call. Takes the already-rendered homepage HTML
 * plus robots.txt/sitemap facts and returns SEOIssue-shaped findings. Written against one page today; each
 * check takes an HTML string so it can run per-page once Phase 2's crawler discovers more than one URL.
 */

const extractTag = (html, re) => { const m = html.match(re); return m ? m[1].trim() : ''; };

/** Finds a <meta attr="value" ... content="..."> tag regardless of attribute order. */
function extractMeta(html, attr, value) {
  const re = new RegExp(`<meta\\b[^>]*\\b${attr}=["']${value}["'][^>]*>`, 'i');
  const tag = (html.match(re) || [])[0];
  if (!tag) return '';
  const m = tag.match(/\bcontent=["']([^"']*)["']/i);
  return m ? m[1] : '';
}

const extractCanonicalHref = (html) => (html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']*)["']/i) || [])[1] || '';
const extractHeadingLevels = (html) => [...html.matchAll(/<h([1-6])\b[^>]*>/gi)].map((m) => Number(m[1]));
const extractSections = (html) => html.split(/(?=<section\b)/i).filter((chunk) => /^<section\b/i.test(chunk));
const extractImgs = (html) => [...html.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]);
const extractIds = (html) => new Set([...html.matchAll(/\bid=["']([^"']+)["']/gi)].map((m) => m[1]));
const extractAnchorHrefs = (html) => [...html.matchAll(/<a\b[^>]*\bhref=["']([^"']*)["'][^>]*>/gi)].map((m) => m[1]);
const extractJsonLdRaw = (html) => (html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i) || [])[1]?.trim() || '';

const issue = (type, severity, detail, recommendation = null) => ({ type, severity, detail, recommendation });

/**
 * @param {string} html - the fully rendered homepage HTML (title/canonical/OG/Twitter/JSON-LD already injected)
 * @param {{ robotsTxt: string|null, sitemapExists: boolean, origin: string }} ctx
 * @returns {Array<{type:string, severity:'critical'|'warning'|'info', detail:string, recommendation:string|null}>}
 */
export function analyzeHomepage(html, { robotsTxt, sitemapExists, origin }) {
  const issues = [];

  /* ---- metadata ---- */
  const title = extractTag(html, /<title>([\s\S]*?)<\/title>/i);
  if (!title) issues.push(issue('missing-title', 'critical', 'The <title> tag is empty or missing.', 'Set a page title in Admin → Site content → Search & sharing.'));
  else if (title.length < 15 || title.length > 60) issues.push(issue('title-length', 'warning', `Title is ${title.length} characters.`, 'Aim for roughly 15–60 characters so it is not truncated in search results.'));

  const description = extractMeta(html, 'name', 'description');
  if (!description) issues.push(issue('missing-description', 'critical', 'The meta description is empty or missing.', 'Set a description in Admin → Site content → Search & sharing.'));
  else if (description.length < 50 || description.length > 160) issues.push(issue('description-length', 'warning', `Meta description is ${description.length} characters.`, 'Aim for roughly 50–160 characters.'));

  const canonicalHref = extractCanonicalHref(html);
  if (!canonicalHref) issues.push(issue('missing-canonical', 'critical', 'No <link rel="canonical"> tag found.', 'Add a canonical tag pointing at the preferred URL.'));
  else if (!/^https?:\/\//i.test(canonicalHref)) issues.push(issue('relative-canonical', 'warning', `Canonical href "${canonicalHref}" is not an absolute URL.`, 'Use a full https:// URL for the canonical tag.'));

  const missingOg = ['og:type', 'og:title', 'og:description', 'og:url', 'og:image', 'og:site_name'].filter((p) => !extractMeta(html, 'property', p));
  if (missingOg.length) issues.push(issue('incomplete-open-graph', 'warning', `Missing Open Graph tags: ${missingOg.join(', ')}.`, 'Add the missing og: tags so shared links render correctly.'));

  const missingTwitter = ['twitter:card', 'twitter:title', 'twitter:description', 'twitter:image'].filter((n) => !extractMeta(html, 'name', n));
  if (missingTwitter.length) issues.push(issue('incomplete-twitter-card', 'warning', `Missing Twitter/X tags: ${missingTwitter.join(', ')}.`, 'Add the missing twitter: tags so shared links render correctly on X.'));

  /* ---- headings ---- */
  const levels = extractHeadingLevels(html);
  const h1Count = levels.filter((l) => l === 1).length;
  if (h1Count === 0) issues.push(issue('missing-h1', 'critical', 'No <h1> found on the page.', 'Every page needs exactly one <h1>.'));
  else if (h1Count > 1) issues.push(issue('multiple-h1', 'warning', `${h1Count} <h1> tags found.`, 'Use a single <h1> per page for a clear topic signal.'));

  for (let i = 1; i < levels.length; i++) {
    if (levels[i] - levels[i - 1] > 1) {
      issues.push(issue('heading-hierarchy-skip', 'info', `Heading level jumps from h${levels[i - 1]} to h${levels[i]}.`, 'Avoid skipping heading levels (e.g. h2 straight to h4).'));
      break;   // one summary finding is enough, not one per occurrence
    }
  }

  const sectionsWithoutHeading = extractSections(html).filter((chunk) => !/<h[1-6]\b/i.test(chunk)).length;
  if (sectionsWithoutHeading) issues.push(issue('section-missing-heading', 'info', `${sectionsWithoutHeading} <section> element(s) have no heading inside them.`, 'Give every section a heading — a visually hidden one (class="sr-only") is fine when it should not show.'));

  /* ---- images ---- */
  const imgs = extractImgs(html);
  const missingAlt = imgs.filter((tag) => !/\balt\s*=\s*["'][^"']*["']/i.test(tag));
  if (missingAlt.length) issues.push(issue('missing-alt', 'warning', `${missingAlt.length} of ${imgs.length} <img> tag(s) have no alt attribute.`, 'Add descriptive alt text to every content image (alt="" is fine for purely decorative images).'));

  /* ---- links ---- */
  const hrefs = extractAnchorHrefs(html);
  const internalCount = hrefs.filter((h) => h.startsWith('#') || h.startsWith('/') || (origin && h.startsWith(origin))).length;
  issues.push(issue('internal-links', 'info', `${internalCount} internal link(s) found on the page.`));

  const ids = extractIds(html);
  const deadAnchors = [...new Set(hrefs.filter((h) => h.startsWith('#') && h.length > 1))].filter((h) => !ids.has(h.slice(1)));
  if (deadAnchors.length) issues.push(issue('broken-anchor-link', 'warning', `Link(s) point at fragments with no matching id: ${deadAnchors.join(', ')}.`, 'Fix or remove the links, or add the missing id to the target element.'));

  /* ---- structured data ---- */
  const jsonLdRaw = extractJsonLdRaw(html);
  if (!jsonLdRaw) issues.push(issue('missing-json-ld', 'critical', 'No JSON-LD structured data found.', 'Add a JSON-LD <script type="application/ld+json"> block.'));
  else {
    try {
      const parsed = JSON.parse(jsonLdRaw);
      if (!parsed['@context'] || !parsed['@type']) issues.push(issue('incomplete-json-ld', 'warning', 'JSON-LD is missing @context or @type.', 'Every JSON-LD block needs @context and @type.'));
    } catch {
      issues.push(issue('invalid-json-ld', 'critical', 'JSON-LD is not valid JSON.', 'Fix the JSON-LD syntax — it currently fails to parse.'));
    }
  }

  /* ---- crawlability ---- */
  if (!robotsTxt) issues.push(issue('missing-robots-txt', 'critical', 'robots.txt is missing or empty.', 'Add a robots.txt file.'));
  else if (/^Disallow:\s*\/\s*$/im.test(robotsTxt)) issues.push(issue('robots-disallow-all', 'critical', 'robots.txt disallows the entire site ("Disallow: /").', 'Remove the blanket Disallow rule unless the whole site is meant to be blocked from search engines.'));

  if (!sitemapExists) issues.push(issue('missing-sitemap', 'critical', 'sitemap.xml was not found.', 'Add a sitemap.xml file.'));
  else if (robotsTxt && !/^Sitemap:/im.test(robotsTxt)) issues.push(issue('sitemap-not-referenced', 'warning', 'sitemap.xml exists but robots.txt does not reference it.', 'Add a "Sitemap:" line to robots.txt.'));

  const robotsMeta = extractMeta(html, 'name', 'robots');
  if (robotsMeta) issues.push(issue('unexpected-robots-meta', 'warning', `A <meta name="robots"> tag was found on a public page: "${robotsMeta}".`, 'Confirm this is intentional — it can block indexing.'));

  return issues;
}

const SEVERITY_WEIGHT = { critical: 15, warning: 5, info: 1 };
export function scoreFromIssues(issues) {
  const deduction = issues.reduce((sum, it) => sum + (SEVERITY_WEIGHT[it.severity] || 0), 0);
  return Math.max(0, 100 - deduction);
}
