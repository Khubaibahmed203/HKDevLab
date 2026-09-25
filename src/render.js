import { iconEl } from './icons.js';
import { buildMeta, buildJsonLd } from '../content/seo.js';

/**
 * Fills the page from the site content (edited in /admin).
 * Everything is inserted as text nodes / created elements — never as HTML strings —
 * so nothing an editor types can inject markup or script.
 */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const pad = (n) => String(n + 1).padStart(2, '0');

function h(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.includes('-')) { if (v != null) n.setAttribute(k, v); }     // data-*, aria-* → real attributes
    else n[k] = v;
  }
  kids.flat().forEach((c) => c != null && n.append(c));
  return n;
}
/** "a\nb" → a<br>b as real nodes */
export function lines(text) {
  const f = document.createDocumentFragment();
  String(text).split('\n').forEach((line, i) => { if (i) f.append(document.createElement('br')); f.append(line); });
  return f;
}
const set = (el, ...kids) => el && el.replaceChildren(...kids);
const setText = (sel, v) => { const el = $(sel); if (el) el.textContent = v; };
const setAttr = (sel, attr, v) => { const el = $(sel); if (el) el.setAttribute(attr, v); };
const safeHref = (v) => (/^(#[\w-]*|\/[^\s]*|https?:\/\/[^\s"'<>]+|mailto:[^\s"'<>]+)$/i.test(v) ? v : '#');

// where each stack tile floats in the 3D fly-through (x, y in vw / vh from centre)
const TILE_SPOTS = [[-34, -18], [30, -24], [-8, -34], [-40, 12], [36, 8], [0, -6], [-30, -26], [28, 24], [-14, 26], [38, -14], [-36, 20], [12, -2], [-22, 4], [24, -8], [-4, 14], [16, 30]];

const MEDIA = /^\/media\/[a-f0-9]{32}$/;                 // photos can only be ones uploaded through the admin
const initials = (name) => {
  const w = String(name || '').trim().split(/\s+/).filter(Boolean).map((x) => Array.from(x)[0]);
  return ((w[0] || '') + (w.length > 1 ? w[w.length - 1] : '')).toUpperCase() || 'HK';
};
const svgArrow = () => {
  const NS = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(NS, 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(NS, 'path'); p.setAttribute('d', 'M7 17 17 7M8 7h9v9'); s.append(p);
  return s;
};

/** The founders block: one portrait card per person. Hidden when switched off or empty. */
function applyFounders(f) {
  const sec = $('#founders');
  if (!sec) return;
  const people = f && f.show && Array.isArray(f.people) ? f.people.filter((p) => p && p.name) : [];
  sec.hidden = !people.length;
  if (!people.length) return;

  setText('#foundersEyebrow', f.eyebrow);
  const tl = String(f.title || '').split('\n');
  const last = tl.pop();
  set($('#foundersTitle'), ...tl.flatMap((l) => [l, h('br')]), h('span', { class: 'grad', text: last }));
  const intro = $('#foundersIntro');
  intro.textContent = f.intro || ''; intro.hidden = !f.intro;

  const grid = $('#foundersGrid');
  grid.dataset.n = String(Math.min(people.length, 4));
  set(grid, ...people.map((p, i) => {
    const photo = MEDIA.test(p.photo || '');
    const url = p.link && p.link !== '#' ? safeHref(p.link) : null;
    const external = !!url && /^https?:/i.test(url);
    const label = (p.linkLabel || '').trim() || 'View portfolio';
    const corners = ['tl', 'tr', 'bl', 'br'].map((c) => h('i', { class: `fc fc--${c}`, 'aria-hidden': 'true' }));
    return h('li', { class: 'founder' },
      h('div', { class: 'founder__media' },
        h('span', { class: 'founder__ghost', 'aria-hidden': 'true' }),
        h('div', { class: 'founder__frame' },
          photo ? h('img', { class: 'founder__img', src: p.photo, alt: `Portrait of ${p.name}`, loading: 'lazy', decoding: 'async', width: 800, height: 1000 })
                : h('div', { class: 'founder__mono', 'aria-hidden': 'true' }, h('span', { text: initials(p.name) })),
          ...corners,
          h('span', { class: 'founder__tag', 'aria-hidden': 'true', text: `Founder ${pad(i)}` }),
          h('span', { class: 'founder__px', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')))),
      h('div', { class: 'founder__info' },
        h('p', { class: 'founder__idx', 'aria-hidden': 'true', text: pad(i) }),
        h('h3', { class: 'founder__name', text: p.name }),
        p.role ? h('p', { class: 'founder__role', text: p.role }) : null,
        p.bio ? h('p', { class: 'founder__bio', text: p.bio }) : null,
        url ? h('a', Object.assign({ class: 'btn btn--ghost btn--sm founder__link', href: url, 'aria-label': `${label} — ${p.name}${external ? ' (opens in a new tab)' : ''}` },
          external ? { target: '_blank', rel: 'noopener noreferrer' } : {}), label, svgArrow()) : null));
  }));
}

export function applyContent(c) {
  document.title = c.seo.title;
  $('meta[name="description"]')?.setAttribute('content', c.seo.description);
  // canonical/og:url/og:image are environment-driven (the production domain), already correct as static
  // defaults in the HTML — only the content-driven fields need updating here to match the server-side path.
  const meta = buildMeta(c);
  setAttr('meta[property="og:title"]', 'content', meta.title);
  setAttr('meta[property="og:description"]', 'content', meta.description);
  setAttr('meta[name="twitter:title"]', 'content', meta.title);
  setAttr('meta[name="twitter:description"]', 'content', meta.description);
  const ld = document.getElementById('ld-json');
  if (ld) ld.textContent = JSON.stringify(buildJsonLd(c));

  /* hero */
  const hero = c.hero;
  setText('#heroEyebrow span', hero.eyebrow);
  ['web', 'ai', 'soft', 'sol'].forEach((k, i) => setText(`.chip--${k} span`, `•${hero.chips[i] ?? ''}•`));
  setText('#heroLede', hero.lede);
  const [primary, secondary] = $$('#heroCta a');
  for (const [a, cta] of [[primary, hero.ctaPrimary], [secondary, hero.ctaSecondary]]) {
    a.href = safeHref(cta.href);
    const svg = $('svg', a);
    a.replaceChildren(cta.label + (svg ? ' ' : ''), ...(svg ? [svg] : []));
  }
  set($('.hero__side--l'), ...hero.sideLeft.map((t) => h('li', { text: t })));
  set($('.hero__side--r'), ...hero.sideRight.map((t) => h('li', { text: t })));

  /* the lab */
  const lab = c.lab;
  setText('.lab__intro .eyebrow', lab.eyebrow);
  $('#statement')?.setAttribute('aria-label', lab.statement.replace(/\*/g, ''));
  const words = $('#statementWords');
  words.replaceChildren(...lab.statement.split(/\*([^*]+)\*/).map((part, i) => (i % 2 ? h('em', { text: part }) : document.createTextNode(part))));
  setText('.universe__cap .eyebrow', lab.stackEyebrow);
  set($('.universe__cap h3'), lines(lab.stackTitle));
  set($('#tiles'), ...lab.tiles.map((t, i) => {
    const [x, y] = TILE_SPOTS[i % TILE_SPOTS.length];
    return h('li', { class: `tile${t.hot ? ' tile--hot' : ''}`, 'data-z': -200 - i * 175, 'data-x': x, 'data-y': y }, h('span', { text: pad(i) }), t.text);
  }));
  set($('#services'), ...lab.services.map((s) => h('li', { class: 'card', 'data-spot': '' }, iconEl(s.icon), h('h4', { text: s.title }), h('p', { text: s.text }))));
  set($('#principles'), ...lab.principles.map((p) => h('li', {}, iconEl(p.icon), h('b', { text: p.title }), h('span', { text: p.text }))));

  applyFounders(c.founders);

  /* process */
  const pr = c.process;
  setText('.process__head .eyebrow', pr.eyebrow);
  set($('#processTitle'), lines(pr.title));
  set($('.process__hint'), lines(pr.hint), h('i'));
  set($('#steps'), ...pr.steps.map((s, i) => h('li', { class: 'step', 'data-label': s.title },
    h('span', { class: 'step__n', text: pad(i) }), h('h3', { text: s.title }), h('p', { text: s.text }),
    s.tags.length ? h('ul', { class: 'tags' }, s.tags.map((t) => h('li', { text: t }))) : null)));
  set($('#rail'), h('i', { class: 'rail__fill', id: 'railFill' }), ...pr.steps.map((s, i) => h('span', { 'data-i': i, text: s.title })));

  /* work (the slides themselves are built by work.js) */
  setText('.work__head .eyebrow', c.work.eyebrow);
  setText('#workTitle', c.work.title);
  const note = $('.work__note'); if (note) { note.textContent = c.work.note; note.hidden = !c.work.note; }

  /* built for */
  setText('.who > .eyebrow', c.who.eyebrow);
  const items = c.who.items;
  set($('.marquee__track'), ...[0, 1].flatMap((dup) => items.map((t) => h('li', { text: t, 'aria-hidden': dup ? 'true' : null }))));

  /* contact */
  const ct = c.contact;
  setText('.contact__copy .eyebrow', ct.eyebrow);
  const titleLines = ct.title.split('\n');
  const last = titleLines.pop();
  set($('#contactTitle'), ...titleLines.flatMap((l) => [l, h('br')]), h('span', { class: 'grad', text: last }));
  setText('.contact__lede', ct.lede);
  set($('#fType'), ...ct.formTypes.map((t) => h('option', { text: t })));

  /* footer */
  set($('.foot small'), `© `, h('span', { id: 'year', text: String(new Date().getFullYear()) }), ` ${c.footer.copyright}`);
}
