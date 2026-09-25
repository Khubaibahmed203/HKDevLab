import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { injectSeo } from '../../content/seo.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Phase 1's "crawl" is entirely local — no network round-trip. It renders the homepage through the exact
 * same injectSeo() the live server uses for a real visitor, and reads robots.txt/sitemap.xml straight off
 * disk, so the analyzer checks precisely what would be served. Phase 2 replaces this with a real HTTP
 * crawler once there is more than one URL to fetch.
 */
export function crawlHomepage(content, origin) {
  const builtIndex = resolve(root, 'dist', 'index.html');
  const templatePath = existsSync(builtIndex) ? builtIndex : resolve(root, 'index.html');
  const raw = readFileSync(templatePath, 'utf8').replace('<!--SITE_CONTENT-->', '');
  const html = injectSeo(raw, content, origin);

  const robotsPath = resolve(root, 'public', 'robots.txt');
  const sitemapPath = resolve(root, 'public', 'sitemap.xml');
  const robotsTxt = existsSync(robotsPath) ? readFileSync(robotsPath, 'utf8') : null;
  const sitemapExists = existsSync(sitemapPath);

  return { html, robotsTxt, sitemapExists };
}
