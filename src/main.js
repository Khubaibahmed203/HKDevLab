import '@fontsource-variable/sora';
import '@fontsource-variable/inter';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import './styles/base.css';
import './styles/sections.css';

import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { initSmooth } from './modules/smooth.js';
import { initField } from './modules/field.js';
import { initChrome } from './modules/chrome.js';
import { heroIntro, heroScroll } from './modules/hero.js';
import { labReveal, labUniverse } from './modules/lab.js';
import { processScene, processReveal } from './modules/process.js';
import { buildWork, workScene } from './modules/work.js';
import { initContact, contactReveal } from './modules/contact.js';
import { applyContent } from './render.js';
import defaults from '../content/default.json';

gsap.registerPlugin(ScrollTrigger);

const $ = (s, r = document) => r.querySelector(s);
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
document.documentElement.classList.add('js');     // shows the preloader straight away, before content loads

/* The site's words live in the database and are edited in /admin. In production the server embeds the
   current content in the page; in development (or if that is missing) fetch it; last resort: the bundled defaults. */
async function loadContent() {
  const embedded = document.getElementById('site-content');
  if (embedded) { try { return JSON.parse(embedded.textContent); } catch { /* fall through */ } }
  try {
    const res = await fetch(`${import.meta.env.VITE_API_URL || ''}/api/content`, { cache: 'no-cache' });
    if (res.ok) return await res.json();
  } catch { /* offline / API down */ }
  return defaults;
}
const content = await loadContent();
applyContent(content);
// the opening is a sequence — always start it from the top
history.scrollRestoration = 'manual';
window.scrollTo(0, 0);

const lenis = reduce ? null : initSmooth();
initField($('#field'), { animate: !reduce });
initChrome({ lenis, reduce });

/* Wide screens with motion allowed get the pinned / 3D "cinema" layout.
   Everything else keeps the simple stacked layout the CSS starts with.
   gsap.matchMedia builds and tears these down cleanly on resize. */
buildWork(content.work.items);
initContact(content.contact);
const mm = gsap.matchMedia();
mm.add('(min-width: 900px) and (prefers-reduced-motion: no-preference)', () => {
  const root = document.documentElement;
  root.classList.add('is-cinema');
  heroScroll();
  const off = labUniverse();
  processScene();
  const offWork = workScene();
  return () => { off(); offWork(); root.classList.remove('is-cinema'); };
});
mm.add('(prefers-reduced-motion: no-preference)', () => { labReveal(); contactReveal(); });
mm.add('(max-width: 899px) and (prefers-reduced-motion: no-preference)', () => { processReveal(); });

/* ───── boot → intro ───── */
async function boot() {
  const bootEl = $('#boot');
  if (reduce) { bootEl.remove(); return; }
  lenis?.stop();
  const t0 = performance.now();
  gsap.to('#bootFill', { scaleX: 0.85, duration: 1.2, ease: 'power2.out' });
  await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 2500))]);
  const wait = Math.max(0, 1000 - (performance.now() - t0));
  await new Promise((r) => setTimeout(r, wait));
  gsap.to('#bootFill', { scaleX: 1, duration: 0.25 });
  await gsap.to(bootEl, { opacity: 0, duration: 0.7, delay: 0.2, ease: 'power2.inOut' });
  bootEl.remove();
  ScrollTrigger.refresh();
  heroIntro().eventCallback('onComplete', () => lenis?.start());
  setTimeout(() => lenis?.start(), 2600); // never leave scroll locked
}
boot();

window.addEventListener('load', () => ScrollTrigger.refresh());
