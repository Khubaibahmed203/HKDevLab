import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

/** Wrap every word of `el` in a span, keeping <em> emphasis as a class. */
function splitWords(el) {
  if (el.dataset.split) return $$('.w', el);
  const out = document.createDocumentFragment();
  const walk = (node, hot) => {
    node.childNodes.forEach((n) => {
      if (n.nodeType === 3) {
        n.textContent.split(/(\s+)/).forEach((tok) => {
          if (!tok) return;
          if (/^\s+$/.test(tok)) { out.append(' '); return; }
          const s = document.createElement('span');
          s.className = hot ? 'w w--hot' : 'w';
          s.textContent = tok;
          out.append(s);
        });
      } else if (n.nodeName === 'EM') walk(n, true);
    });
  };
  walk(el, false);
  el.replaceChildren(out);
  el.dataset.split = '1';
  return $$('.w', el);
}

/** Motion-allowed reveals: statement scrubs in word by word, cards rise in. */
export function labReveal() {
  const words = splitWords($('#statementWords'));
  gsap.set(words, { opacity: 0.14 });
  gsap.to(words, {
    opacity: 1, ease: 'none', duration: 0.5, stagger: 0.1,
    scrollTrigger: { trigger: '#statement', start: 'top 82%', end: 'bottom 45%', scrub: 0.5 },
  });

  // one trigger per item, so a stacked (phone) layout reveals each card as IT arrives — not all at once from the top
  const rise = (sel, y, stagger) => {
    gsap.set(sel, { y, opacity: 0 });
    ScrollTrigger.batch(sel, {
      start: 'top 92%', once: true,
      onEnter: (els) => gsap.to(els, { y: 0, opacity: 1, duration: 0.95, stagger, ease: 'power3.out', overwrite: true, clearProps: 'transform,opacity' }),
    });
  };
  rise('.card', 60, 0.1);
  rise('#principles li', 30, 0.09);
  gsap.from('.universe__cap > *', {
    y: 30, opacity: 0, duration: 1, stagger: 0.12, ease: 'power3.out',
    scrollTrigger: { trigger: '.universe', start: 'top 70%' },
  });
}

/**
 * The stack flies past the camera (every screen size). Each tile lives at a depth
 * (data-z); scrolling pushes the whole scene forward, and opacity is derived
 * from each tile's distance to the camera so tiles emerge from the dark and
 * dissolve as they pass.
 */
export function labUniverse() {
  const scene = $('#uniScene');
  const cap = $('.universe__cap');
  const tiles = $$('.tile').map((el) => ({
    el, z: +el.dataset.z,
    x: +el.dataset.x, y: +el.dataset.y,
  }));
  tiles.forEach((t) => {
    t.el.style.setProperty('--x', t.x);
    t.el.style.setProperty('--y', t.y);
    gsap.set(t.el, { xPercent: -50, yPercent: -50, rotationY: -t.x * 0.35, rotationX: t.y * 0.2 });
  });

  const smooth = (a, b, v) => { const k = Math.min(1, Math.max(0, (v - a) / (b - a))); return k * k * (3 - 2 * k); };
  const apply = (push) => {
    tiles.forEach((t) => {
      const z = t.z + push;
      const alpha = smooth(-1700, -900, z) * (1 - smooth(60, 300, z));
      gsap.set(t.el, { z, opacity: alpha, visibility: alpha < 0.01 ? 'hidden' : 'visible' });
    });
  };
  apply(0);

  // the caption lives inside the 3D scene at a fixed depth: nearer tiles pass
  // in front of it, farther ones behind. scale(1.55) cancels perspective shrink.
  gsap.set(cap, { yPercent: -50, z: -500, scale: 1.55 });

  const state = { push: 0 };
  gsap.to(state, {
    push: Math.max(...tiles.map((t) => -t.z)) + 240, ease: 'none',
    onUpdate: () => apply(state.push),
    scrollTrigger: { trigger: '#universe', start: 'top top', end: 'bottom bottom', scrub: 0.7 },
  });
  // caption breathes back as the last tile passes
  gsap.fromTo(cap, { opacity: 1 }, {
    opacity: 0, scale: 1.75, ease: 'none',
    scrollTrigger: { trigger: '#universe', start: '82% top', end: 'bottom bottom', scrub: true },
  });

  // gentle pointer parallax — the scene tilts toward the cursor
  const pin = $('.universe__pin');
  const rx = gsap.quickTo(scene, 'rotationX', { duration: 1.1, ease: 'power3' });
  const ry = gsap.quickTo(scene, 'rotationY', { duration: 1.1, ease: 'power3' });
  const move = (e) => {
    const r = pin.getBoundingClientRect();
    ry(((e.clientX - r.left) / r.width - 0.5) * 8);
    rx(-((e.clientY - r.top) / r.height - 0.5) * 6);
  };
  pin.addEventListener('pointermove', move);
  return () => pin.removeEventListener('pointermove', move);
}
