import { iconEl } from './icons.js';

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
const safeHref = (v) => (/^(#[\w-]*|\/[^\s]*|https?:\/\/[^\s"'<>]+|mailto:[^\s"'<>]+)$/i.test(v) ? v : '#');

// where each stack tile floats in the 3D fly-through (x, y in vw / vh from centre)
const TILE_SPOTS = [[-34, -18], [30, -24], [-8, -34], [-40, 12], [36, 8], [0, -6], [-30, -26], [28, 24], [-14, 26], [38, -14], [-36, 20], [12, -2], [-22, 4], [24, -8], [-4, 14], [16, 30]];

export function applyContent(c) {
  document.title = c.seo.title;
  $('meta[name="description"]')?.setAttribute('content', c.seo.description);

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
