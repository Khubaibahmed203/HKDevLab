import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

/** Header, mobile menu, anchor links, scroll progress, card spotlight. */
export function initChrome({ lenis, reduce }) {
  const hdr = $('#hdr');
  const menu = $('#menu');
  const burger = $('#burger');

  // solid header once the page has moved
  const onScroll = () => hdr.classList.toggle('is-solid', window.scrollY > 24);
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  // scroll progress bar
  if (!reduce) {
    gsap.to('#progress', { scaleX: 1, ease: 'none', scrollTrigger: { start: 0, end: 'max', scrub: 0.25 } });
  }

  // active link per section
  const links = $$('.hdr__nav a[data-nav]');
  links.forEach((a) => {
    const target = $(a.getAttribute('href'));
    if (!target) return;
    ScrollTrigger.create({
      trigger: target, start: 'top 55%', end: 'bottom 55%',
      onToggle: (self) => self.isActive && links.forEach((l) => l.classList.toggle('is-active', l === a)),
    });
  });

  // anchor navigation (through Lenis when it is running)
  const goTo = (hash) => {
    const el = hash === '#top' ? document.documentElement : $(hash);
    if (!el) return false;
    closeMenu();                               // first: an open menu has stopped Lenis, and Lenis ignores scrollTo() while it is stopped
    if (lenis) lenis.scrollTo(hash === '#top' ? 0 : el, { duration: 1.6, easing: (t) => 1 - Math.pow(1 - t, 4) });
    else el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth' });
    history.replaceState(null, '', hash);
    return true;
  };
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href^="#"]');
    if (!a || a.getAttribute('href') === '#') return;
    if (goTo(a.getAttribute('href'))) e.preventDefault();
  });

  // mobile menu
  function openMenu() {
    menu.hidden = false; burger.setAttribute('aria-expanded', 'true'); lenis?.stop();
    document.documentElement.style.overflow = 'hidden';
    $('a', menu)?.focus();
  }
  function closeMenu() {
    if (menu.hidden) return;
    menu.hidden = true; burger.setAttribute('aria-expanded', 'false'); lenis?.start();
    document.documentElement.style.overflow = '';
  }
  burger.addEventListener('click', () => (menu.hidden ? openMenu() : closeMenu()));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeMenu(); burger.focus(); } });
  const wide = matchMedia('(min-width: 900px)');
  const onWide = (e) => e.matches && closeMenu();
  if (wide.addEventListener) wide.addEventListener('change', onWide); else if (wide.addListener) wide.addListener(onWide);   // Safari < 14

  // glass-card spotlight follows the pointer
  $$('[data-spot]').forEach((card) => {
    card.addEventListener('pointermove', (e) => {
      const r = card.getBoundingClientRect();
      card.style.setProperty('--mx', `${e.clientX - r.left}px`);
      card.style.setProperty('--my', `${e.clientY - r.top}px`);
    });
  });

  $('#year').textContent = new Date().getFullYear();
}
