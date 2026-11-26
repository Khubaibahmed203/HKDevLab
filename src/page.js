/* The content pages (services, about, case studies, blog): the same fonts, colours, header and footer as the homepage,
   with none of its scroll cinema. The only script is the mobile menu and the footer year — every word is already in the HTML. */
import '@fontsource-variable/sora';
import '@fontsource-variable/inter';
import '@fontsource/jetbrains-mono/400.css';
import './styles/base.css';
import './styles/page.css';

const $ = (s, r = document) => r.querySelector(s);
const menu = $('#menu');
const burger = $('#burger');

function setMenu(open) {
  menu.hidden = !open;
  burger.setAttribute('aria-expanded', String(open));
  document.documentElement.style.overflow = open ? 'hidden' : '';
  if (open) $('a', menu)?.focus();
}
burger?.addEventListener('click', () => setMenu(menu.hidden));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && menu && !menu.hidden) { setMenu(false); burger.focus(); } });
menu?.addEventListener('click', (e) => { if (e.target.closest('a')) setMenu(false); });
const wide = matchMedia('(min-width: 900px)');
const onWide = (e) => { if (e.matches && menu && !menu.hidden) setMenu(false); };
if (wide.addEventListener) wide.addEventListener('change', onWide); else if (wide.addListener) wide.addListener(onWide);   // Safari < 14

const year = $('#year');
if (year) year.textContent = String(new Date().getFullYear());
