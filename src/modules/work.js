import gsap from 'gsap';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

/* The concepts come from the site content (edited in /admin). Everything is escaped before it
   becomes markup, and colours are re-checked, so content can never inject HTML or CSS. */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const br = (s) => esc(s).replace(/\n/g, '<br>');
const color = (c, fallback) => (/^#[0-9a-f]{6}$/i.test(c) ? c : fallback);

const dots = '<i></i><i></i><i></i>';
const bar = (url) => `<div class="mock__bar">${dots}<u>${esc(url)}</u></div>`;
const nav = (name, items, cta) => `<div class="mock__nav"><b>${esc(name)}</b>${(items || []).map((i) => `<span>${esc(i)}</span>`).join('')}<em>${esc(cta)}</em></div>`;
const first = (w) => String(w.name).split(' ')[0];
const webUrl = (s) => (/^https?:\/\/[^\s"'<>]+$/i.test(s || '') ? s : '');   // only real web addresses ever become a link
const liveHref = (w) => webUrl(w.liveUrl);          // the project's real landing page — always the admin-saved address, never hardcoded here
const gitHref = (w) => webUrl(w.githubUrl);
const techOf = (w) => (w.technologies || []).filter(Boolean).join(' · ');
const hostPath = (u) => { try { const x = new URL(u); return x.host + (x.pathname === '/' && !x.search ? '' : x.pathname) + x.search; } catch { return ''; } };   // project.vercel.app/products
const lock = '<svg class="mock__lock" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 10V8a5 5 0 0 1 10 0v2M6 10h12v10H6z"/></svg>';
const urlBar = (u) => `<div class="mock__bar">${dots}<u>${/^https:/i.test(u) ? lock : ''}<span>${esc(hostPath(u))}</span></u></div>`;
// The project's landing page as it looks today: a screenshot taken from its Live URL by `npm run capture-project-previews` and shipped as a
// static file (the server works out its address — see previewPath). Same-origin only. It loads once the section is near (workScene) and,
// if the file is missing, is dropped so the project's name card behind it shows instead.
const shot = (w) => (/^\/assets\/projects\/[\w-]+\.webp$/.test(w.preview || '') ? `<img data-src="${esc(w.preview)}" alt="" width="1440" height="900" decoding="async">` : '');

const KIND = {
  // The card is the project's real landing page in a browser window: the address bar shows its Live URL, the viewport its screenshot.
  live: (w) => `${urlBar(liveHref(w))}<div class="mock__shot"><p class="mock__t">${esc(w.name)}</p>${shot(w)}</div>`,
  hero: (w) => `${bar(w.url)}<div class="mock__body">${nav(first(w), w.nav, 'Start')}
    <div><p class="mock__t">${br(w.title)}</p><p class="mock__s">${esc(w.sub)}</p>${w.cta ? `<span class="mock__btn">${esc(w.cta)}</span>` : ''}</div>
    <div class="mock__art"><span class="ring2"></span><span class="orb"></span><span class="sq"></span><span class="sq"></span></div></div>`,
  dash: (w) => `${bar(w.url)}<div class="mock__body"><div class="dash__side"><i></i><i></i><i></i><i></i><i></i></div>
    <div class="dash__main"><div class="dash__kpis">${(w.kpis || []).map((k) => `<div><small>${esc(k.label)}</small>${esc(k.value)}</div>`).join('')}</div>
    <div class="dash__chart">${(w.bars || []).map((n) => `<i style="height:${Math.min(100, Math.max(4, +n || 0))}%"></i>`).join('')}</div></div></div>`,
  chat: (w) => `${bar(w.url)}<div class="mock__body">${(w.chat || []).map((m) => `<div class="bub${m.mine ? ' bub--me' : ''}">${esc(m.text)}</div>`).join('')}<div class="bub bub--typing">${dots}</div></div>`,
  shop: (w) => `${bar(w.url)}<div class="mock__body">${nav(first(w), w.nav, 'Cart')}<p class="mock__t" style="margin-top:calc(5 * var(--u))">${br(w.title)}</p>
    <div class="shop__row"><div class="shop__p"></div><div class="shop__p"></div><div class="shop__p"></div><div class="shop__p"></div></div></div>`,
};

let WORK = [];

/* Browsers without container-query units (Chrome < 105, Safari < 16) get the same sizes from a per-slide pixel unit. */
const HAS_CQ = typeof CSS !== 'undefined' && CSS.supports && CSS.supports('width', '1cqw');
function sizeUnits() { if (!HAS_CQ) $$('.slide').forEach((s) => s.style.setProperty('--u', (s.offsetWidth / 100) + 'px')); }

/** Builds the concept slides (used by both the 3D ring and the mobile swipe list). */
export function buildWork(items) {
  WORK = items;
  const list = $('#ringInner');
  $('#work').hidden = !WORK.length;                     // every concept is a draft / not featured / deleted → no empty section
  list.innerHTML = WORK.map((w, i) => {
    const href = liveHref(w), git = gitHref(w), tech = techOf(w);
    const mock = `<div class="mock mock--${KIND[w.kind] ? w.kind : 'hero'}" style="--a:${color(w.a, '#12a6ff')};--b:${color(w.b, '#0b74ff')}" aria-hidden="true">${(KIND[w.kind] || KIND.hero)(w)}</div>`;
    const cap = `<div class="slide__cap"><span class="work__idx"><b>${String(i + 1).padStart(2, '0')}</b></span><h3>${esc(w.name)}</h3><p>${esc(w.meta)}</p>${w.description ? `<p class="slide__desc">${esc(w.description)}</p>` : ''}${tech ? `<p class="slide__tech">${esc(tech)}</p>` : ''}${href ? '<span class="btn btn--ghost btn--sm">View live <span aria-hidden="true">→</span></span>' : ''}</div>`;
    return `<li class="slide" data-i="${i}">${href
      ? `<a class="slide__link" href="${esc(href)}" target="_blank" rel="noopener noreferrer" aria-label="${esc(w.name)} — view live site (opens in a new tab)">${mock}${cap}</a>`
      : mock + cap}${git ? `<a class="slide__git" href="${esc(git)}" target="_blank" rel="noopener noreferrer">GitHub ↗</a>` : ''}</li>`;
  }).join('');
  $('#workTot').textContent = String(WORK.length).padStart(2, '0');
  sizeUnits();
  if (!HAS_CQ) window.addEventListener('resize', sizeUnits);
}

/**
 * Pinned 3D carousel (every screen size). Cards sit on a cylinder; scroll rotates it.
 * --d (0 front … 1 far) drives each card's dimming so the ring reads as depth.
 */
export function workScene() {
  const inner = $('#ringInner');
  const slides = $$('.slide', inner);
  const n = slides.length;
  if (!n) return () => {};                               // nothing to show (section is hidden)
  const slots = Math.max(n, 6);          // a cylinder needs ≥ 3 faces — with only a few projects, space them as on a 6-card ring so they keep their depth
  const step = 360 / slots;
  let R = 900;

  slides.forEach((s, i) => s.style.setProperty('--i', i));
  $('#work').style.setProperty('--len', n);             // scroll length the sticky stage stays put for
  inner.style.setProperty('--step', `${step}deg`);

  const layout = () => {
    sizeUnits();
    R = (inner.offsetWidth / 2) / Math.tan(Math.PI / slots) * 1.14;
    inner.style.setProperty('--R', `${R}px`);
    render(state.rot);
  };

  const state = { rot: 0 };
  let shown = -1;
  function render(rot) {
    gsap.set(inner, { z: -R, rotationY: rot });
    let front = 0, best = 1e9;
    slides.forEach((s, i) => {
      const a = ((i * step + rot) % 360 + 540) % 360 - 180;   // signed angle from the front, −180…180
      const d = Math.min(1, Math.abs(a) / (step * 2.3));
      s.style.setProperty('--d', d.toFixed(3));
      if (Math.abs(a) < best) { best = Math.abs(a); front = i; }
    });
    if (front !== shown) {
      shown = front;
      const w = WORK[front];
      $('#workIdx').textContent = String(front + 1).padStart(2, '0');
      gsap.fromTo('#workName, #workMeta, #workDesc, #workTech, #workLive, #workGit', { y: 14, opacity: 0 }, { y: 0, opacity: 1, duration: 0.5, stagger: 0.06, ease: 'expo.out', overwrite: true });
      const href = liveHref(w), git = gitHref(w), tech = techOf(w);
      for (const [a, to] of [[$('#workNameLink'), href], [$('#workLive'), href], [$('#workGit'), git]]) { if (to) a.href = to; else a.removeAttribute('href'); }
      $('#workNameLink').textContent = w.name;
      $('#workMeta').textContent = w.meta;
      $('#workDesc').textContent = w.description || '';
      $('#workTech').textContent = tech;
      $('#workDesc').hidden = !w.description; $('#workTech').hidden = !tech;
      $('#workLive').hidden = !href; $('#workGit').hidden = !git;
    }
  }

  /* Screenshots. Seven images would be wasted on a visitor who never scrolls this far, so they load when the section is near the screen
     (or straight away when the browser has no IntersectionObserver). A missing file is dropped, leaving the name card behind it. */
  const imgs = $$('.mock__shot img[data-src]', inner);
  const load = () => imgs.forEach((img) => { if (img.dataset.src) { img.src = img.dataset.src; img.removeAttribute('data-src'); } });
  imgs.forEach((img) => img.addEventListener('error', () => img.remove()));
  const io = 'IntersectionObserver' in window ? new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { load(); io.disconnect(); } }, { rootMargin: '600px 0px' }) : null;

  layout();
  window.addEventListener('resize', layout);
  if (io) io.observe($('#work')); else load();

  gsap.to(state, {
    rot: -step * (n - 1), ease: 'none',
    onUpdate: () => render(state.rot),
    scrollTrigger: { trigger: '#work', start: 'top top', end: 'bottom bottom', scrub: 0.7 },     // stage is CSS-sticky (sections.css)
  });

  return () => { window.removeEventListener('resize', layout); if (io) io.disconnect(); };
}
