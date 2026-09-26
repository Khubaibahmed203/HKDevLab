import * as cheerio from 'cheerio';
import { createHash } from 'node:crypto';

/**
 * Turns one fetched HTML page into structured facts — everything the technical/on-page analyzer and the
 * link graph need. Uses cheerio (a real HTML parser) rather than regex: this runs against pages we don't
 * fully control the markup of (any future service/blog/case-study page, eventually other sites), unlike
 * content/seo.js's injectSeo(), which only ever templates our own fixed index.html and can stay regex-based.
 */
export function extractPage(html) {
  const $ = cheerio.load(html);

  const title = $('title').first().text().trim();
  const description = ($('meta[name="description"]').attr('content') || '').trim();
  const canonical = ($('link[rel="canonical"]').attr('href') || '').trim();
  const robotsMeta = ($('meta[name="robots"]').attr('content') || '').trim();
  const lang = ($('html').attr('lang') || '').trim();
  const hasViewport = $('meta[name="viewport"]').length > 0;

  const ogTitle = ($('meta[property="og:title"]').attr('content') || '').trim();
  const ogDescription = ($('meta[property="og:description"]').attr('content') || '').trim();
  const ogImage = ($('meta[property="og:image"]').attr('content') || '').trim();
  const twitterCard = ($('meta[name="twitter:card"]').attr('content') || '').trim();

  const jsonLdBlocks = $('script[type="application/ld+json"]').map((_, el) => $(el).html() || '').get();
  const jsonLdPresent = jsonLdBlocks.length > 0;
  const jsonLdValid = jsonLdBlocks.every((block) => { try { JSON.parse(block); return true; } catch { return false; } });

  const headingLevels = $('h1,h2,h3,h4,h5,h6').map((_, el) => Number(el.tagName.slice(1))).get();
  const h1Count = headingLevels.filter((l) => l === 1).length;
  const h2Count = headingLevels.filter((l) => l === 2).length;
  const sectionsWithoutHeading = $('section').filter((_, el) => $(el).find('h1,h2,h3,h4,h5,h6').length === 0).length;

  const images = $('img').map((_, el) => ({ src: $(el).attr('src') || '', hasAlt: $(el).attr('alt') !== undefined })).get();
  const missingAltCount = images.filter((i) => !i.hasAlt).length;

  const links = [];
  $('a[href]').each((_, el) => {
    const href = ($(el).attr('href') || '').trim();
    if (!href || /^(javascript|mailto|tel):/i.test(href)) return;
    links.push({ href, text: $(el).text().trim().slice(0, 200) });
  });

  const bodyClone = $('body').clone();
  bodyClone.find('script,style,noscript,nav,footer').remove();
  const bodyText = bodyClone.text().replace(/\s+/g, ' ').trim();
  const wordCount = bodyText ? bodyText.split(' ').length : 0;
  const normalizedForHash = bodyText.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
  const contentHash = normalizedForHash.length > 40 ? createHash('sha256').update(normalizedForHash).digest('hex') : null;   // too short to compare meaningfully

  const ids = $('[id]').map((_, el) => $(el).attr('id')).get();
  const duplicateIds = ids.length - new Set(ids).size;

  return {
    title, description, canonical, robotsMeta, lang, hasViewport,
    ogTitle, ogDescription, ogImage, twitterCard,
    jsonLdPresent, jsonLdValid,
    h1Count, h2Count, headingLevels, sectionsWithoutHeading,
    images, missingAltCount,
    links, wordCount, contentHash, duplicateIds,
  };
}
