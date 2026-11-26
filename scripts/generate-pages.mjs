// `node scripts/generate-pages.mjs` — writes the site's pages beyond the homepage, plus the sitemap and llms.txt, from content/site.js.
// Runs automatically before `npm run build` and `npm run dev` (the "prebuild" / "predev" scripts), so the HTML always matches the data.
//
//   services/<slug>/index.html, about/index.html, work/<slug>/index.html, blog/index.html, blog/<slug>/index.html
//       → Vite builds each one (vite.config.js) to the same path under dist/. These folders are generated: edit content/site.js, not them.
//   public/sitemap.xml, public/llms.txt  → copied as-is into dist/ by Vite.
//
// Every piece of copy is HTML-escaped here; nothing in content/site.js is ever treated as markup.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUSINESS, CTA_OFFER, SERVICES, ABOUT, CASE_STUDIES, BLOG, POSTS, PAGES, LASTMOD, pageName } from '../content/site.js';
import { buildJsonLd, buildFaqJsonLd, esc, siteOrigin, SITE_NAME, OG_IMAGE_PATH } from '../content/seo.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CONTENT = JSON.parse(readFileSync(resolve(root, 'content/default.json'), 'utf8'));
const ORIGIN = siteOrigin(process.env.PUBLIC_URL);
export const GENERATED_DIRS = ['services', 'about', 'work', 'blog'];

const ldScript = (obj) => `<script type="application/ld+json">${JSON.stringify(obj).replace(/</g, '\\u003c')}</script>`;
const fmtDate = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

/* ───────── shared chrome ───────── */
const NAV = [['/#lab', 'Services'], ['/#work', 'Work'], ['/about', 'About'], ['/blog', 'Blog'], ['/#contact', 'Contact']];
const navItems = (current) => NAV.map(([href, label]) => {
  const here = current === href || (href === '/blog' && current.startsWith('/blog')) || (href === '/#work' && current.startsWith('/work')) || (href === '/#lab' && current.startsWith('/services'));
  return `<li><a href="${href}" data-nav${here ? ' class="is-active" aria-current="page"' : ''}>${esc(label)}</a></li>`;
}).join('\n      ');

const waLink = (text = `WhatsApp ${BUSINESS.whatsapp}`) => `<a href="${BUSINESS.whatsappUrl}" target="_blank" rel="noopener noreferrer">${esc(text)}</a>`;
const mailLink = () => `<a href="mailto:${BUSINESS.email}">${esc(BUSINESS.email)}</a>`;

function header(current) {
  return `<a class="skip" href="#main">Skip to content</a>
<header class="hdr is-solid" id="hdr">
  <a class="hdr__logo" href="/" aria-label="HK DevLab — home">
    <img src="/brand/logo-wide.png" alt="HKDevLab" width="1215" height="257">
  </a>
  <nav class="hdr__nav" aria-label="Primary">
    <ul>
      ${navItems(current)}
    </ul>
  </nav>
  <a class="btn btn--sm hdr__cta" href="/#contact">Start a project</a>
  <button class="hdr__burger" id="burger" aria-expanded="false" aria-controls="menu">
    <span aria-hidden="true"></span><span aria-hidden="true"></span>
    <span class="sr-only">Menu</span>
  </button>
</header>
<nav class="menu" id="menu" aria-label="Primary, expanded" hidden>
  <ul>
      ${navItems(current)}
  </ul>
  <p class="menu__tag">Web • AI • Software • Solutions</p>
</nav>`;
}

function footer() {
  return `<footer class="foot">
  <div class="wrap foot__grid">
    <img class="foot__logo" src="/brand/logo-stacked.png" alt="HKDevLab — Web, AI, Software, Solutions" width="889" height="617" loading="lazy">
    <nav aria-label="Footer">
      <ul>
        ${NAV.map(([href, label]) => `<li><a href="${href}">${esc(label)}</a></li>`).join('\n        ')}
      </ul>
      <ul class="foot__services">
        ${SERVICES.map((s) => `<li><a href="/services/${s.slug}">${esc(s.name)}</a></li>`).join('\n        ')}
      </ul>
    </nav>
    <address class="foot__nap">${esc(BUSINESS.name)} — ${esc(BUSINESS.city)}, ${esc(BUSINESS.country)} · ${mailLink()} · ${waLink()}</address>
    <div class="foot__meta">
      <small>&copy; <span id="year">${LASTMOD.slice(0, 4)}</span> ${esc(DEFAULT_CONTENT.footer.copyright)}</small>
    </div>
  </div>
</footer>`;
}

function crumbs(trail) {
  const items = [['/', 'Home'], ...trail];
  return `<nav class="crumbs" aria-label="Breadcrumb"><ol>${items.map(([href, label], i) => (i === items.length - 1
    ? `<li><span aria-current="page">${esc(label)}</span></li>`
    : `<li><a href="${href}">${esc(label)}</a></li>`)).join('')}</ol></nav>`;
}

/* ───────── body blocks ───────── */
function blocks(list) {
  return list.map((b) => {
    switch (b.type) {
      case 'p': return `<p>${esc(b.text)}</p>`;
      case 'h2': return `<h2>${esc(b.text)}</h2>`;
      case 'ul': return `<ul>${b.items.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>`;
      case 'lead': return `<p><strong>${esc(b.label)}</strong> ${esc(b.text)}</p>`;
      case 'link': return `<p><strong>${esc(b.label)}</strong> <a href="${esc(b.href)}" target="_blank" rel="noopener noreferrer">${esc(b.text)}</a></p>`;
      default: throw new Error(`unknown block type: ${b.type}`);
    }
  }).join('\n      ');
}

const faqSection = (faq) => `<section class="faq" aria-labelledby="faqTitle">
      <h2 id="faqTitle">FAQ</h2>
      ${faq.map(([q, a]) => `<div class="faq__item"><h3>${esc(q)}</h3><p>${esc(a)}</p></div>`).join('\n      ')}
    </section>`;

const relatedSection = (paths) => (paths?.length ? `<section class="related" aria-labelledby="relatedTitle">
      <h2 id="relatedTitle">Related</h2>
      <ul>${paths.map((p) => `<li><a href="${p}">${esc(pageName(p))} <span aria-hidden="true">→</span></a></li>`).join('')}</ul>
    </section>` : '');

const ctaBox = (text, { offer = false } = {}) => `<aside class="cta-box" aria-label="Contact HK DevLab">
      <p class="cta-box__text">${esc(text)} — ${mailLink()} · ${waLink()}.</p>${offer ? `
      <p class="cta-box__offer">${esc(CTA_OFFER)}</p>` : ''}
      <div class="cta-box__acts">
        <a class="btn" href="/#contact">Send a message <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg></a>
        <a class="btn btn--ghost" href="${BUSINESS.whatsappUrl}" target="_blank" rel="noopener noreferrer">Chat on WhatsApp</a>
      </div>
    </aside>`;

/* ───────── the page ───────── */
function page({ path, title, description, ogType = 'website', jsonLd = [], body }) {
  const url = `${ORIGIN}${path}`;
  const org = buildJsonLd(DEFAULT_CONTENT, ORIGIN);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(url)}">
<meta name="theme-color" content="#000000">
<meta property="og:type" content="${ogType}">
<meta property="og:site_name" content="${SITE_NAME}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(url)}">
<meta property="og:image" content="${ORIGIN}${OG_IMAGE_PATH}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${ORIGIN}${OG_IMAGE_PATH}">
<link rel="icon" type="image/png" href="/brand/favicon.png">
<link rel="apple-touch-icon" href="/brand/favicon.png">
${[org, ...jsonLd].map(ldScript).join('\n')}
<script type="module" src="/src/page.js"></script>
</head>
<body class="subpage">
${header(path)}
<main id="main" class="page">
  <article class="wrap page__wrap">
${body}
  </article>
</main>
${footer()}
</body>
</html>
`;
}

const head = ({ trail, eyebrow, h1, lede, extra = '' }) => `    ${crumbs(trail)}
    <header class="page__head">
      <p class="eyebrow">${esc(eyebrow)}</p>
      <h1>${esc(h1)}</h1>
      ${lede ? `<p class="page__lede">${esc(lede)}</p>` : ''}${extra}
    </header>`;

const out = [];   // [path, html]

for (const s of SERVICES) {
  const path = `/services/${s.slug}`;
  out.push([path, page({
    path, title: s.title, description: s.description, jsonLd: [buildFaqJsonLd(s.faq)],
    body: `${head({ trail: [['/#lab', 'Services'], [path, s.name]], eyebrow: 'Service', h1: s.h1, lede: s.intro })}
    <div class="prose">
      ${blocks(s.body)}
    </div>
    ${ctaBox(s.cta)}
    ${faqSection(s.faq)}
    ${relatedSection(s.related)}`,
  })]);
}

out.push(['/about', page({
  path: '/about', title: ABOUT.title, description: ABOUT.description,
  body: `${head({ trail: [['/about', 'About']], eyebrow: 'About', h1: ABOUT.h1, lede: ABOUT.intro })}
    <div class="prose">
      ${blocks(ABOUT.body)}
    </div>
    ${ctaBox('Tell us about your project', { offer: true })}
    ${relatedSection(ABOUT.related)}`,
})]);

for (const c of CASE_STUDIES) {
  const path = `/work/${c.slug}`;
  const facts = `
      <dl class="facts">${c.facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}<div><dt>Live site</dt><dd><a href="${esc(c.liveUrl)}" target="_blank" rel="noopener noreferrer">${esc(c.liveUrl.replace(/^https?:\/\//, ''))}</a></dd></div></dl>`;
  out.push([path, page({
    path, title: c.title, description: c.description,
    body: `${head({ trail: [['/#work', 'Work'], [path, c.name]], eyebrow: 'Case study', h1: c.h1, extra: facts })}
    ${c.screenshot ? `<figure class="shot"><img src="${esc(c.screenshot)}" alt="The ${esc(c.name)} homepage" width="1440" height="900" loading="lazy" decoding="async"></figure>` : ''}
    <div class="prose">
      ${blocks(c.body)}
    </div>
    ${ctaBox(c.cta + ' Free 15-minute call or free website check')}
    ${relatedSection(c.related)}`,
  })]);
}

out.push(['/blog', page({
  path: '/blog', title: BLOG.title, description: BLOG.description,
  body: `${head({ trail: [['/blog', 'Blog']], eyebrow: 'Blog', h1: BLOG.h1, lede: BLOG.intro })}
    <ul class="posts">
      ${POSTS.map((b) => `<li class="post-card"><a href="/blog/${b.slug}"><time datetime="${b.published}">${esc(fmtDate(b.published))}</time><h2>${esc(b.title)}</h2><p>${esc(b.answer)}</p><span class="post-card__more">Read the article <span aria-hidden="true">→</span></span></a></li>`).join('\n      ')}
    </ul>
    ${ctaBox('Have a question about your own website or idea? Ask us', { offer: true })}`,
})]);

for (const b of POSTS) {
  const path = `/blog/${b.slug}`;
  const article = {
    '@context': 'https://schema.org', '@type': 'BlogPosting', headline: b.title, description: b.description,
    datePublished: b.published, dateModified: b.published, mainEntityOfPage: `${ORIGIN}${path}`, image: `${ORIGIN}${OG_IMAGE_PATH}`,
    author: { '@id': `${ORIGIN}/#organization` }, publisher: { '@id': `${ORIGIN}/#organization` },
  };
  out.push([path, page({
    path, title: b.title, description: b.description, ogType: 'article', jsonLd: [article],
    body: `${head({ trail: [['/blog', 'Blog'], [path, b.title]], eyebrow: 'Blog', h1: b.title, extra: `\n      <p class="page__meta"><time datetime="${b.published}">${esc(fmtDate(b.published))}</time> · ${esc(SITE_NAME)}</p>` })}
    <div class="prose">
      <p class="answer">${esc(b.answer)}</p>
      ${blocks(b.body)}
    </div>
    ${ctaBox(b.cta)}
    ${relatedSection(b.related)}`,
  })]);
}

/* ───────── write ───────── */
for (const dir of GENERATED_DIRS) rmSync(resolve(root, dir), { recursive: true, force: true });   // a removed page must not linger
for (const [path, html] of out) {
  const file = resolve(root, `.${path}`, 'index.html');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, html);
}
const missing = PAGES.filter((pg) => pg.path !== '/' && !out.some(([path]) => path === pg.path));
if (missing.length) throw new Error(`content/site.js lists pages that were not generated: ${missing.map((m) => m.path).join(', ')}`);

const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${PAGES.map((pg) => `  <url>
    <loc>${esc(`${ORIGIN}${pg.path}`)}</loc>
    <lastmod>${pg.lastmod || LASTMOD}</lastmod>
    <changefreq>${pg.changefreq}</changefreq>
    <priority>${pg.priority.toFixed(1)}</priority>
  </url>`).join('\n')}
</urlset>
`;
writeFileSync(resolve(root, 'public/sitemap.xml'), sitemap);

const llms = `# ${SITE_NAME}

> ${SITE_NAME} is a digital development studio in ${BUSINESS.city}, ${BUSINESS.country}, building websites, web apps, AI assistants and custom software for startups and small businesses.

Contact: ${BUSINESS.email} | WhatsApp: ${BUSINESS.whatsapp}
Process: Discover, Design, Build, Launch, Grow
Free: 15-minute project call, website check

## Services
- [Website Development](${ORIGIN}/services/website-development): mobile-first business websites
- [Web App Development](${ORIGIN}/services/web-app-development): dashboards, portals, booking systems, MVPs
- [AI Assistants & Automation](${ORIGIN}/services/ai-assistants): customer chat assistants in English and Roman Urdu
- [Custom Software](${ORIGIN}/services/custom-software): internal tools and integrations

## About
- [About HK DevLab](${ORIGIN}/about)
- [Blog](${ORIGIN}/blog)

## Work
${CASE_STUDIES.map((c) => `- [${c.name} case study](${ORIGIN}/work/${c.slug}): ${c.description}`).join('\n')}

## Blog posts
${POSTS.map((b) => `- [${b.title}](${ORIGIN}/blog/${b.slug})`).join('\n')}
`;
writeFileSync(resolve(root, 'public/llms.txt'), llms);

console.log(`generated ${out.length} pages, public/sitemap.xml (${PAGES.length} URLs) and public/llms.txt`);
