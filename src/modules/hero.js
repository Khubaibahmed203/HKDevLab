import gsap from 'gsap';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

/**
 * Opening sequence: black → eyebrow → wordmark rises letter by letter →
 * the logo's pixel squares snap in → chips pop → copy + header settle.
 * Runs once. Returns the timeline so main.js can release scroll at the end.
 */
export function heroIntro() {
  const letters = $$('.wordmark i');
  const px = $$('.px');
  const chips = $$('.chip span');
  const sides = $$('.hero__side li');

  gsap.set(letters, { yPercent: 70, opacity: 0, filter: 'blur(16px)' });
  gsap.set('#heroEyebrow', { opacity: 0 });
  gsap.set('#heroEyebrow span', { letterSpacing: '0.9em' });
  gsap.set(px, { opacity: 0, scale: 0 });
  gsap.set(chips, { opacity: 0, scale: 0.6 });
  gsap.set('#heroLower > *', { opacity: 0, y: 26 });
  gsap.set(sides, { opacity: 0, x: (i, el) => (el.parentElement.classList.contains('hero__side--l') ? -18 : 18) });
  gsap.set('#heroScroll', { opacity: 0 });
  gsap.set('#hdr', { yPercent: -110 });

  const tl = gsap.timeline({ defaults: { ease: 'expo.out' }, delay: 0.15 });
  tl.to('#heroEyebrow', { opacity: 1, duration: 0.8, ease: 'power2.out' })
    .to('#heroEyebrow span', { letterSpacing: '0.32em', duration: 1.6 }, '<')
    .to(letters, { yPercent: 0, opacity: 1, filter: 'blur(0px)', duration: 1.25, stagger: 0.075 }, 0.25)
    .to(px, {
      opacity: 1, scale: 1, duration: 0.7, stagger: 0.09, ease: 'back.out(2.4)',
      startAt: { x: () => gsap.utils.random(-140, 140), y: () => gsap.utils.random(-120, 80), rotation: () => gsap.utils.random(-90, 90) },
      x: 0, y: 0, rotation: 0,
    }, 1.05)
    .to(chips, { opacity: 1, scale: 1, duration: 0.55, stagger: 0.1, ease: 'back.out(2)' }, 1.3)
    .to('#heroLower > *', { opacity: 1, y: 0, duration: 1, stagger: 0.12 }, 1.35)
    .to(sides, { opacity: 1, x: 0, duration: 0.8, stagger: 0.06 }, 1.5)
    .to('#hdr', { yPercent: 0, duration: 1, clearProps: 'transform' }, 1.5)
    .to('#heroScroll', { opacity: 1, duration: 0.8, ease: 'power2.out' }, 2.1);

  // idle: the pixels bob like they're still being assembled
  px.forEach((el, i) => gsap.to(el, { y: i % 2 ? -7 : 7, duration: 2.2 + i * 0.4, ease: 'sine.inOut', yoyo: true, repeat: -1, delay: 2.5 }));

  return tl;
}

/** Scroll-out: the hero recedes as you leave it (every screen size, via matchMedia in main.js). */
export function heroScroll() {
  const k = Math.min(1, window.innerWidth / 1100);       // chip drift scales with the screen so nothing flies off a phone
  const tl = gsap.timeline({
    defaults: { ease: 'none' },
    scrollTrigger: { trigger: '.hero', start: 'top top', end: 'bottom bottom', scrub: 0.6 },
  });
  tl.to('#heroLower', { y: -60, opacity: 0, duration: 0.35 }, 0)
    .to('#heroScroll', { opacity: 0, duration: 0.15 }, 0)
    .to('.hero__wm', { scale: 1.55, opacity: 0, filter: 'blur(10px)', duration: 0.9, transformOrigin: '50% 50%' }, 0.1)
    .to('.chip--web', { x: -90 * k, y: -50 * k, duration: 0.9 }, 0.1)
    .to('.chip--ai', { x: 60 * k, y: -70 * k, duration: 0.9 }, 0.1)
    .to('.chip--soft', { x: -70 * k, y: 60 * k, duration: 0.9 }, 0.1)
    .to('.chip--sol', { x: 90 * k, y: 50 * k, duration: 0.9 }, 0.1)
    .to('#heroEyebrow', { opacity: 0, y: -30, duration: 0.4 }, 0)
    .to('.hero__side', { opacity: 0, duration: 0.4 }, 0);
  return tl;
}
