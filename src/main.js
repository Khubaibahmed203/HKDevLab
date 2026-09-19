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
import { processScene } from './modules/process.js';
import { buildWork, workScene } from './modules/work.js';
import { initContact, contactReveal } from './modules/contact.js';
import { motionPlan, initMotionUI } from './modules/motion.js';
import { isWeakDevice, watchPerformance } from './modules/perf.js';
import { applyContent } from './render.js';
import defaults from '../content/default.json';

gsap.registerPlugin(ScrollTrigger);
ScrollTrigger.config({ ignoreMobileResize: true });   // a phone's address bar sliding in/out must not rebuild the scenes

const $ = (s, r = document) => r.querySelector(s);
const html = document.documentElement;
const plan = motionPlan();                            // animations are on for everyone unless the visitor turned them off
html.classList.add('js', plan.on ? 'motion-on' : 'motion-off');
if (isWeakDevice()) html.classList.add('is-lite');    // same show, without the GPU-hungry extras

/* ───── compatibility: older phones and browsers ───── */
if (!Element.prototype.replaceChildren) {            // Safari < 14, Chrome < 86
  Element.prototype.replaceChildren = function () { while (this.firstChild) this.removeChild(this.firstChild); this.append.apply(this, arguments); };
}
const timeoutSignal = (ms) => {                      // AbortSignal.timeout needs Safari 16 / Chrome 103
  if (typeof AbortController === 'undefined') return {};
  const c = new AbortController(); setTimeout(() => c.abort(), ms); return { signal: c.signal };
};

/* If anything at all goes wrong on some device, show the plain site (all content, no animation) instead of a dead page. */
function safeMode(err) {
  console.error('[hkdevlab] falling back to the plain site:', err);
  html.classList.remove('is-cinema', 'is-compact', 'is-short'); html.classList.add('no-anim');
  const boot = document.getElementById('boot'); if (boot) boot.remove();
}

/* The site's words live in the database and are edited in /admin. In production the server embeds the
   current content in the page; otherwise fetch it; last resort: the bundled defaults. */
async function loadContent() {
  const embedded = document.getElementById('site-content');
  if (embedded) { try { return JSON.parse(embedded.textContent); } catch (e) { /* fall through */ } }
  try {
    const res = await fetch((import.meta.env.VITE_API_URL || '') + '/api/content', Object.assign({ cache: 'no-cache' }, timeoutSignal(4000)));   // a cold server must never hold the page hostage
    if (res.ok) return await res.json();
  } catch (e) { /* offline / API down */ }
  return defaults;
}

async function start() {
  const content = await loadContent();
  applyContent(content);
  // the opening is a sequence — always start it from the top
  history.scrollRestoration = 'manual';
  window.scrollTo(0, 0);

  const lenis = plan.on ? initSmooth() : null;
  const field = initField($('#field'), { animate: plan.on, lite: html.classList.contains('is-lite') });
  initChrome({ lenis, reduce: !plan.on });
  initMotionUI(plan);

  buildWork(content.work.items);
  initContact(content.contact);

  /* The cinema runs on EVERY screen: desktops, laptops, tablets and phones. Only the composition changes
     (CSS re-arranges each scene for portrait / short screens). gsap.matchMedia rebuilds it cleanly when the
     screen crosses a breakpoint or is rotated. */
  if (plan.on) {
    const mm = gsap.matchMedia();
    mm.add({ all: true, compact: '(max-width: 899px)', short: '(max-height: 560px)' }, (ctx) => {   // `all` = always run, whatever the screen
      const { compact, short } = ctx.conditions;
      html.classList.add('is-cinema');
      html.classList.toggle('is-compact', compact);
      html.classList.toggle('is-short', short);
      heroScroll();
      const off = labUniverse();
      processScene();
      const offWork = workScene();
      labReveal();
      contactReveal();
      return () => { off(); offWork(); html.classList.remove('is-cinema', 'is-compact', 'is-short'); };
    });
    watchPerformance(() => field.lite());
  }

  /* ───── boot → intro ───── */
  async function boot() {
    const bootEl = $('#boot');
    if (!plan.on) { bootEl.remove(); return; }
    if (lenis) lenis.stop();
    const t0 = performance.now();
    gsap.to('#bootFill', { scaleX: 0.85, duration: 1.2, ease: 'power2.out' });
    await Promise.race([document.fonts ? document.fonts.ready : Promise.resolve(), new Promise((r) => setTimeout(r, 2500))]);
    const wait = Math.max(0, 1000 - (performance.now() - t0));
    await new Promise((r) => setTimeout(r, wait));
    gsap.to('#bootFill', { scaleX: 1, duration: 0.25 });
    await gsap.to(bootEl, { opacity: 0, duration: 0.7, delay: 0.2, ease: 'power2.inOut' });
    bootEl.remove();
    ScrollTrigger.refresh();
    heroIntro().eventCallback('onComplete', () => { if (lenis) lenis.start(); });
    setTimeout(() => { if (lenis) lenis.start(); }, 2600); // never leave scroll locked
  }
  boot().catch(safeMode);

  window.addEventListener('load', () => ScrollTrigger.refresh());
}

start().catch(safeMode);
