/**
 * Search/social metadata and structured data, computed from the same `content` document the CMS already
 * edits — the ONE definition used by both the server (renders it into the HTML before sending) and the
 * browser (keeps the live DOM in sync if content is applied client-side). Plain ES module, no dependencies,
 * runs in Node and in the browser — same pattern as content/schema.js.
 */
export const SITE_NAME = 'HK DevLab';
export const DEFAULT_ORIGIN = 'https://www.hkdevlab.com';
export const OG_IMAGE_PATH = '/brand/og.jpg';

export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** The production origin, with an optional override (e.g. PUBLIC_URL) for a self-hosted deployment under a
 *  different domain. Deliberately NOT derived from the current request's host — a preview/staging deployment
 *  must still declare www.hkdevlab.com as canonical, never its own throwaway URL. */
export function siteOrigin(override) {
  const raw = String(override || DEFAULT_ORIGIN).trim().replace(/\/+$/, '');
  return raw || DEFAULT_ORIGIN;
}

export function buildMeta(content, origin) {
  const base = siteOrigin(origin);
  return {
    title: content.seo.title,
    description: content.seo.description,
    siteName: SITE_NAME,
    canonical: `${base}/`,
    ogUrl: `${base}/`,
    ogImage: `${base}${OG_IMAGE_PATH}`,
  };
}

/** ProfessionalService is the only schema type the current one-page site has enough verified information to
 *  fill in — name/url/description/email/serviceType. No reviews, ratings, address or prices: none of that
 *  exists in the CMS, and inventing it would be false structured data. Extensible: Organization, Service,
 *  BreadcrumbList, FAQPage and Article schemas plug in the same way once the pages they describe exist. */
export function buildJsonLd(content, origin) {
  const base = siteOrigin(origin);
  const serviceType = (content.lab?.services || []).map((s) => s.title).filter(Boolean);
  const doc = {
    '@context': 'https://schema.org',
    '@type': 'ProfessionalService',
    name: SITE_NAME,
    url: `${base}/`,
    description: content.seo.description,
  };
  if (content.contact?.email) doc.email = content.contact.email;
  if (serviceType.length) doc.serviceType = serviceType;
  return doc;
}

const safeScriptJson = (obj) => JSON.stringify(obj).replace(/</g, '\\u003c');   // can't break out of the <script>

/**
 * Templates computed meta + JSON-LD into an index.html string. Pure string function — the SAME code path
 * serves live requests (server/app.js) and the Phase-1 SEO analyzer (server/seo/crawl.js), so the page the
 * analyzer checks and the page a visitor actually receives can never drift apart.
 */
export function injectSeo(html, content, origin) {
  const meta = buildMeta(content, origin);
  const jsonLd = buildJsonLd(content, origin);
  return html
    .replace(/<title>[\s\S]*?<\/title>/, () => `<title>${esc(meta.title)}</title>`)
    .replace(/(<link rel="canonical" href=")[^"]*(")/, (m, a, b) => `${a}${esc(meta.canonical)}${b}`)
    .replace(/(<meta name="description" content=")[^"]*(")/, (m, a, b) => `${a}${esc(meta.description)}${b}`)
    .replace(/(<meta property="og:site_name" content=")[^"]*(")/, (m, a, b) => `${a}${esc(meta.siteName)}${b}`)
    .replace(/(<meta property="og:title" content=")[^"]*(")/, (m, a, b) => `${a}${esc(meta.title)}${b}`)
    .replace(/(<meta property="og:description" content=")[^"]*(")/, (m, a, b) => `${a}${esc(meta.description)}${b}`)
    .replace(/(<meta property="og:url" content=")[^"]*(")/, (m, a, b) => `${a}${esc(meta.ogUrl)}${b}`)
    .replace(/(<meta property="og:image" content=")[^"]*(")/, (m, a, b) => `${a}${esc(meta.ogImage)}${b}`)
    .replace(/(<meta name="twitter:title" content=")[^"]*(")/, (m, a, b) => `${a}${esc(meta.title)}${b}`)
    .replace(/(<meta name="twitter:description" content=")[^"]*(")/, (m, a, b) => `${a}${esc(meta.description)}${b}`)
    .replace(/(<meta name="twitter:image" content=")[^"]*(")/, (m, a, b) => `${a}${esc(meta.ogImage)}${b}`)
    .replace(/(<script type="application\/ld\+json" id="ld-json">)[\s\S]*?(<\/script>)/, (m, a, b) => `${a}${safeScriptJson(jsonLd)}${b}`);
}
