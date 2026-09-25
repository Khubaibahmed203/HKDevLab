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

const KIND = {
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
  list.innerHTML = WORK.map((w, i) => `
    <li class="slide" data-i="${i}">
      <div class="mock mock--${KIND[w.kind] ? w.kind : 'hero'}" style="--a:${color(w.a, '#12a6ff')};--b:${color(w.b, '#0b74ff')}" aria-hidden="true">${(KIND[w.kind] || KIND.hero)(w)}</div>
      <div class="slide__cap"><h3>${esc(w.name)}</h3><p>${esc(w.meta)}</p></div>
    </li>`).join('');
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
  const step = 360 / n;
  let R = 900;

  slides.forEach((s, i) => s.style.setProperty('--i', i));
  $('#work').style.setProperty('--len', n);             // scroll length the sticky stage stays put for
  inner.style.setProperty('--step', `${step}deg`);

  const layout = () => {
    sizeUnits();
    R = (inner.offsetWidth / 2) / Math.tan(Math.PI / n) * 1.14;
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
      gsap.fromTo('#workName, #workMeta', { y: 14, opacity: 0 }, { y: 0, opacity: 1, duration: 0.5, stagger: 0.06, ease: 'expo.out', overwrite: true });
      $('#workName').textContent = w.name;
      $('#workMeta').textContent = w.meta;
    }
  }

  layout();
  window.addEventListener('resize', layout);

  gsap.to(state, {
    rot: -step * (n - 1), ease: 'none',
    onUpdate: () => render(state.rot),
    scrollTrigger: { trigger: '#work', start: 'top top', end: 'bottom bottom', scrub: 0.7 },     // stage is CSS-sticky (sections.css)
  });

  return () => window.removeEventListener('resize', layout);
}
