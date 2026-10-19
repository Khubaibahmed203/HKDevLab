// The mobile menu and in-page navigation (src/modules/chrome.js): choosing a section in the open menu must close the menu, give scrolling back and then
// scroll to that section. Opening the menu stops Lenis, and Lenis ignores scrollTo() while it is stopped, so the menu has to be closed FIRST.
// chrome.js is driven through a tiny fake DOM and a fake Lenis that, like the real one, does nothing when asked to scroll while stopped.
// Not covered here (needs a person with a screen): how it looks and feels. Run: node server/test-mobile-menu.mjs
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { (cond ? pass++ : fail++); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };

/** A page with the pieces chrome.js touches. `lenis` may be null (animations off); returns helpers to poke it. */
function page({ lenis }) {
  const handlers = { click: [], keydown: [] };
  const focused = [], replaced = [];
  const docEl = { style: {} };
  const el = (id) => ({
    id, hidden: false, textContent: '', attrs: {}, listeners: {}, scrolledIntoView: [],
    classList: { toggle() {} },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k] ?? null; },
    addEventListener(t, f) { (this.listeners[t] ||= []).push(f); },
    focus() { focused.push(this.id); },
    scrollIntoView(opts) { this.scrolledIntoView.push({ opts, menuHidden: menu.hidden, overflow: docEl.style.overflow }); },
  });
  const hdr = el('hdr'), menu = el('menu'), burger = el('burger'), year = el('year'), firstLink = el('menu-first-link');
  menu.hidden = true; burger.attrs['aria-expanded'] = 'false';
  menu.querySelector = (s) => (s === 'a' ? firstLink : null);
  const sections = { '#lab': el('lab'), '#process': el('process'), '#work': el('work'), '#contact': el('contact') };
  const byId = { '#hdr': hdr, '#menu': menu, '#burger': burger, '#year': year, ...sections };

  globalThis.document = { documentElement: docEl, querySelector: (s) => byId[s] ?? null, querySelectorAll: () => [], addEventListener: (t, f) => handlers[t]?.push(f) };
  globalThis.window = { scrollY: 0, addEventListener() {} };
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  globalThis.history = { replaceState: (a, b, hash) => replaced.push(hash) };

  const api = {
    docEl, menu, burger, firstLink, sections, focused, replaced,
    toggleBurger: () => burger.listeners.click.forEach((f) => f()),
    key: (key) => handlers.keydown.forEach((f) => f({ key })),
    /** A click on an in-page link; `href` null means the click landed on something that is not a link. */
    click: (href) => {
      const link = href === null ? null : { getAttribute: (k) => (k === 'href' ? href : null) };
      const ev = { target: { closest: (s) => (s === 'a[href^="#"]' ? link : null) }, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
      handlers.click.forEach((f) => f(ev));
      return ev;
    },
  };
  return { api, init: (initChrome) => initChrome({ lenis, reduce: true }) };    // reduce only skips the progress-bar animation; with a Lenis it plays no part in navigation
}

/** Like Lenis: stop() / start() flip a flag, and scrollTo() does nothing at all while stopped. */
function fakeLenis() {
  return {
    isStopped: false, starts: 0, scrolls: [],
    stop() { this.isStopped = true; },
    start() { if (this.isStopped) { this.isStopped = false; this.starts++; } },
    scrollTo(target, opts) { this.scrolls.push({ target, scrolled: !this.isStopped, duration: opts && opts.duration }); },
  };
}

const { initChrome } = await import('../src/modules/chrome.js');

/* ═══ 1. menu open: every section link closes the menu, restores scrolling AND scrolls ═══ */
for (const href of ['#lab', '#process', '#work', '#contact', '#top']) {
  const lenis = fakeLenis(), p = page({ lenis });
  p.init(initChrome);
  p.api.toggleBurger();
  ok(`${href}: opening the menu shows it, stops Lenis and locks the page scroll (the situation that broke navigation)`, !p.api.menu.hidden && lenis.isStopped && p.api.docEl.style.overflow === 'hidden');
  const ev = p.api.click(href);
  const want = href === '#top' ? 0 : p.api.sections[href];
  ok(`${href}: the click is handled by the page, not left to the browser`, ev.defaultPrevented);
  ok(`${href}: the menu closes`, p.api.menu.hidden && p.api.burger.attrs['aria-expanded'] === 'false');
  ok(`${href}: Lenis is running again and the page scroll lock is gone`, !lenis.isStopped && p.api.docEl.style.overflow === '');
  ok(`${href}: Lenis is asked to scroll exactly once`, lenis.scrolls.length === 1, String(lenis.scrolls.length));
  ok(`${href}: …and it does so while running, so the page really scrolls (a stopped Lenis would ignore it)`, lenis.scrolls[0]?.scrolled === true);
  ok(`${href}: …to the right place, with the usual 1.6 s glide`, lenis.scrolls[0]?.target === want && lenis.scrolls[0]?.duration === 1.6);
  ok(`${href}: the address shows the section`, p.api.replaced.at(-1) === href);
}

/* ═══ 2. menu closed (desktop, or after the menu was dismissed): navigation is unchanged ═══ */
{
  const lenis = fakeLenis(), p = page({ lenis });
  p.init(initChrome);
  const ev = p.api.click('#work');
  ok('menu closed: a section link scrolls exactly once, through Lenis, while it is running', ev.defaultPrevented && lenis.scrolls.length === 1 && lenis.scrolls[0].scrolled && lenis.scrolls[0].target === p.api.sections['#work']);
  ok('menu closed: nothing is stopped or started and the page scroll lock is untouched', lenis.starts === 0 && !lenis.isStopped && p.api.docEl.style.overflow === undefined && p.api.menu.hidden);
}

/* ═══ 3. animations off (no Lenis): the browser scrolls, and only after the menu has closed ═══ */
{
  const p = page({ lenis: null });
  p.init(initChrome);
  p.api.toggleBurger();
  const ev = p.api.click('#process');
  const s = p.api.sections['#process'].scrolledIntoView;
  ok('no Lenis: the section is scrolled into view exactly once, with no smooth animation (reduced motion)', ev.defaultPrevented && s.length === 1 && s[0].opts.behavior === 'auto', JSON.stringify(s));
  ok('no Lenis: the menu was already closed and the page scroll lock already removed when the scroll started', s[0]?.menuHidden === true && s[0]?.overflow === '', JSON.stringify(s));
  ok('no Lenis: the menu ends closed', p.api.menu.hidden);
}

/* ═══ 4. things that must NOT change ═══ */
{
  const lenis = fakeLenis(), p = page({ lenis });
  p.init(initChrome);
  p.api.toggleBurger();
  const ev = p.api.click('#nope');
  ok('a link to a section that does not exist is left to the browser: not handled, the menu stays open, nothing scrolls', !ev.defaultPrevented && !p.api.menu.hidden && lenis.isStopped && lenis.scrolls.length === 0);
  const bare = p.api.click('#');
  ok('a bare "#" link is ignored', !bare.defaultPrevented && !p.api.menu.hidden && lenis.scrolls.length === 0);
  const other = p.api.click(null);
  ok('a click that is not on a link is ignored', !other.defaultPrevented && !p.api.menu.hidden && lenis.scrolls.length === 0);
}
{
  const lenis = fakeLenis(), p = page({ lenis });
  p.init(initChrome);
  p.api.toggleBurger();
  ok('opening the menu moves keyboard focus to its first link', p.api.focused.at(-1) === 'menu-first-link');
  p.api.toggleBurger();
  ok('the menu button closes the menu again and gives scrolling back', p.api.menu.hidden && !lenis.isStopped && p.api.docEl.style.overflow === '');
  p.api.toggleBurger();
  p.api.key('Enter');
  ok('other keys leave the open menu alone', !p.api.menu.hidden && lenis.isStopped);
  p.api.key('Escape');
  ok('Escape closes the menu, gives scrolling back and returns focus to the menu button', p.api.menu.hidden && !lenis.isStopped && p.api.focused.at(-1) === 'burger');
}

console.log(`\n${pass} passed, ${fail} failed`);
setTimeout(() => process.exit(fail ? 1 : 0), 50);
