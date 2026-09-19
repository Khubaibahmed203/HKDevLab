import gsap from 'gsap';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const NS = 'http://www.w3.org/2000/svg';
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function buildTicks(n) {
  const g = $('#dialTicks');
  g.replaceChildren();
  const step = 360 / n;
  const tick = (deg, len, big) => {
    const l = document.createElementNS(NS, 'line');
    l.setAttribute('x1', 300); l.setAttribute('x2', 300);
    l.setAttribute('y1', 14); l.setAttribute('y2', 14 + len);
    l.setAttribute('transform', `rotate(${deg} 300 300)`);
    l.setAttribute('class', big ? 'd-tick d-tick--big' : 'd-tick');
    g.append(l);
  };
  for (let i = 0; i < 120; i++) {                     // fine ticks every 3°, skipping those next to a stage mark
    const deg = i * 3, off = deg % step;
    if (off < 1.5 || step - off < 1.5) continue;
    tick(deg, i % 4 === 0 ? 14 : 8, false);
  }
  for (let k = 0; k < n; k++) tick(k * step, 28, true);   // one big tick per stage
}

/**
 * Wide screens: one pinned scene. Scroll drives a single timeline — the dial
 * clicks 72° per stage, the big numeral and copy swap, the rail fills.
 */
export function processScene() {
  const steps = $$('.step');
  const labels = $$('#rail span');
  const num = $('#dialNum span');
  const n = steps.length;
  const deg = 360 / n;                                  // the dial turns one stage per step
  buildTicks(n);

  gsap.set(steps.slice(1), { opacity: 0, y: 44 });
  gsap.set(steps.slice(1), { pointerEvents: 'none' });

  const tl = gsap.timeline({
    defaults: { ease: 'none' },
    // refreshPriority: pins measure first so triggers created later (nav) see the pin spacing
    scrollTrigger: { trigger: '#process', pin: '#processPin', start: 'top top', end: `+=${n * 84}%`, scrub: 0.6, anticipatePin: 1, refreshPriority: 1 },
    onUpdate: sync,
  });
  tl.set({}, {}, n);   // fixed length: stage i owns [i, i+1]

  for (let i = 0; i < n - 1; i++) {
    tl.to(steps[i], { opacity: 0, y: -44, duration: 0.22 }, i + 0.72)
      .to(steps[i + 1], { opacity: 1, y: 0, duration: 0.24 }, i + 0.82)
      .to('#dialRing', { rotation: -deg * (i + 1), duration: 0.32, ease: 'power2.inOut', transformOrigin: '50% 50%' }, i + 0.7);
  }
  tl.to('#dialHand', { rotation: 6, duration: n, ease: 'sine.inOut', yoyo: true, transformOrigin: '50% 50%' }, 0);

  let shown = -1;
  function sync() {
    const t = tl.time();
    const idx = clamp(Math.floor(t - 0.85) + 1, 0, n - 1);
    gsap.set('#railFill', { scaleX: clamp(t / (n - 0.15), 0, 1) });
    if (idx === shown) return;
    shown = idx;
    labels.forEach((l, i) => l.classList.toggle('is-on', i <= idx));
    num.textContent = String(idx + 1).padStart(2, '0');
    gsap.fromTo(num, { y: 26, opacity: 0, scale: 0.94 }, { y: 0, opacity: 1, scale: 1, duration: 0.5, ease: 'expo.out', overwrite: true });
    steps.forEach((s, i) => { s.style.pointerEvents = i === idx ? 'auto' : 'none'; s.toggleAttribute('data-active', i === idx); });
  }
  sync();
}

/** Phones / tablets: the stacked cards simply rise in. */
export function processReveal() {
  gsap.from('.step', {
    y: 44, opacity: 0, duration: 0.9, stagger: 0.12, ease: 'power3.out', clearProps: 'transform,opacity',
    scrollTrigger: { trigger: '#steps', start: 'top 85%' },
  });
}
