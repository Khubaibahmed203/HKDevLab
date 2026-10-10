import { createAvatar } from '@bible-strong/avatar-web';
import definition from '../hkdevlab.avatar.json';

const SIZES = [120, 80, 56];    // full size first, then smaller where space is tight
const GAP = 12;                 // button → mascot
const TIP_GAP = 8;              // mascot → speech bubble
const EDGE = 12;                // viewport margin for roaming spots
const PAD = 14;                 // clear space kept around the mascot, so drifting content can't reach it between checks
const TIP_PAD = 8;              // same, for the bubble
const COLS = 7; const ROWS = 5; // roaming grid (per size)
const WAKE_MS = 2000;           // "waking" lasts this long, then idle
const LAUGH_MS = 3000;
const DROWSY_MS = 30000;        // no mouse, scroll or typing for this long → drowsy
const SLEEP_MS = 40000;         // …and 10 s later → sleeping
const TAP_MS = 1600;            // on touch screens a tap plays the "hover" reaction for this long
const BTN = '.btn, button, a[href^="#"]:not(.skip), .work__git, .work__live';       // everything that counts as a button
const FIELD = '.field-row input, .field-row select, .field-row textarea';
const HARD_TAG = /^(IMG|SVG|PATH|CANVAS|VIDEO|BUTTON|A|INPUT|SELECT|TEXTAREA)$/;              // always content
const TEXT_TAG = /^(LABEL|H[1-6]|P|LI|SPAN|SMALL|B|I|EM|STRONG)$/;                              // content only when they hold text
const LAYOUT_TAG = /^(MAIN|SECTION|FOOTER)$/;

/* First match wins: [selector, animation, tip]. */
const BUTTONS = [
  ['#form button[type="submit"]', 'proud', "Ready? I'll send it right over."],
  ['.hero__cta .btn--ghost', 'curious', 'Take a peek at our live projects.'],
  ['.hero__cta .btn, .hdr__cta', 'excited', "Let's build something great together!"],   // the main button
  ['.hdr__burger', 'playful', 'Menu: jump anywhere you like.'],
  ['.hdr__logo', 'happy', "That's us! Back to the top."],
  ['a[href="#lab"]', 'curious', "Here's what the lab does."],
  ['a[href="#process"]', 'thinking', 'Five steps, from idea to launch.'],
  ['a[href="#work"]', 'proud', 'Our projects, live online.'],
  ['a[href="#contact"]', 'happy', 'Say hello. We reply fast.'],
  ['.hero__scroll', 'playful', "Scroll down, there's more!"],
  ['.work__live', 'excited', 'Open it live in a new tab!'],
  ['.work__git', 'playful', 'Peek at the code on GitHub.'],
  ['#motionToggle', 'drowsy', 'Too much motion? Switch it here.'],
  ['.motion-pill button', 'shy', 'Animations are your call.'],
];
const entryFor = (b) => BUTTONS.find(([sel]) => b.matches(sel)) || [null, 'happy', 'Go on, give it a click!'];

/* [selector, animation, tip] for the section in the middle of the screen. */
const SECTIONS = [
  ['#top', 'happy', 'Welcome to the lab! Scroll to explore.'],
  ['#lab', 'curious', 'Every great product starts as an idea.'],
  ['#process', 'thinking', 'Five simple steps, from idea to launch.'],
  ['#work', 'proud', 'Real projects, live online. Take a look!'],
  ['.who', 'playful', 'Startups and growing teams, welcome!'],
  ['#contact', 'listening', 'Got an idea? Tell us. We reply fast.'],
  ['.foot', 'happy', 'Thanks for stopping by!'],
];
const SECTION_MS = 5000;        // how long a section's tip and pose stay up after you arrive

/** Is this element something the mascot must not cover (text, media, controls, or a painted surface)? */
function isContent(el) {
  if (!el || el.id === 'field' || el === document.documentElement || el === document.body) return false;
  const tag = el.tagName.toUpperCase();
  if (HARD_TAG.test(tag)) return true;
  if (TEXT_TAG.test(tag) && el.textContent.trim()) return true;
  if (Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.nodeValue.trim())) return true;
  if (LAYOUT_TAG.test(tag)) return false;
  const s = getComputedStyle(el);
  return s.backgroundImage !== 'none' || (s.backgroundColor !== 'rgba(0, 0, 0, 0)' && s.backgroundColor !== 'transparent') || parseFloat(s.borderTopWidth) > 0;
}

/** Inside the viewport, and everything on top across the rect (plus `pad`) is empty layout or something `ok` allows.
 *  The mascot itself is looked through, so it still sees what is underneath it. */
function rectFree(x, y, w, h, pad, ok) {
  if (x < 4 || y < 4 || x + w > innerWidth - 4 || y + h > innerHeight - 4) return false;
  const W = w + pad * 2; const H = h + pad * 2;
  const nx = Math.min(8, Math.ceil(W / 24)); const ny = Math.min(8, Math.ceil(H / 24));
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      const px = x - pad + (W * (i + 0.5)) / nx; const py = y - pad + (H * (j + 0.5)) / ny;
      if (px < 0 || py < 0 || px > innerWidth || py > innerHeight) continue;
      const hit = document.elementsFromPoint(px, py).find((e) => !e.closest('.mascot'));
      if (hit && ok(hit)) continue;
      if (isContent(hit)) return false;
    }
  }
  return true;
}

const shown = (b) => b.width > 0 && b.height > 0 && b.top >= 0 && b.bottom <= innerHeight && b.left >= 0 && b.right <= innerWidth;

/** Where the speech bubble can sit next to the mascot: right, left, below or above. */
function bubbleSpot(x, y, s, bw, bh, pad, ok) {
  const cx = x + s / 2; const cy = y + s / 2;
  const clampX = (v) => Math.max(8, Math.min(innerWidth - bw - 8, v));
  const clampY = (v) => Math.max(8, Math.min(innerHeight - bh - 8, v));
  return [
    ['right', x + s + TIP_GAP, clampY(cy - bh / 2)],
    ['left', x - TIP_GAP - bw, clampY(cy - bh / 2)],
    ['below', clampX(cx - bw / 2), y + s + TIP_GAP],
    ['above', clampX(cx - bw / 2), y - TIP_GAP - bh],
  ].map(([side, bx, by]) => ({ side, x: bx, y: by }))
    .find((c) => rectFree(c.x, c.y, bw, bh, pad, ok)) || null;
}

/** First clear spot (with room for the bubble when `withBubble`) beside a button. */
function findLayout(btn, bw, bh, withBubble) {
  const panel = btn.closest('.form');                          // a form's own empty surface doesn't count as content
  const okM = (h) => btn.contains(h) || (panel && h === panel);
  const okB = (h) => panel && h === panel;
  const b = btn.getBoundingClientRect();
  for (const s of SIZES) {
    const spots = [[b.right + GAP, b.top + b.height / 2 - s / 2], [b.left - GAP - s, b.top + b.height / 2 - s / 2],
      [b.left + b.width / 2 - s / 2, b.bottom + GAP], [b.left + b.width / 2 - s / 2, b.top - GAP - s]];
    for (const [x, y] of spots) {
      if (!rectFree(x, y, s, s, panel ? 0 : PAD, okM)) continue;
      if (!withBubble) return { x, y, s, bubble: null };
      const bubble = bubbleSpot(x, y, s, bw, bh, panel ? 0 : TIP_PAD, okB);
      if (bubble) return { x, y, s, bubble };
    }
  }
  return null;
}

/**
 * Roaming: a path across the screen driven by scroll progress; the mascot takes the clear spot nearest to it,
 * and stays where it is while that spot is still clear and still close enough to the path (no twitching).
 */
function roamLayout(bw, bh, withBubble, keep) {
  const p = Math.min(1, scrollY / Math.max(1, document.documentElement.scrollHeight - innerHeight));
  const tx = innerWidth * (0.5 + 0.42 * Math.sin(p * 18.85)); const ty = innerHeight * (0.5 + 0.38 * Math.sin(p * 31.4 + 1));
  const stay = 0.3 * Math.min(innerWidth, innerHeight);
  const never = () => false;
  for (const s of SIZES) {
    const dist = ([x, y]) => Math.hypot(x + s / 2 - tx, y + s / 2 - ty);
    const spots = [];
    for (let i = 0; i < COLS; i++) {
      for (let j = 0; j < ROWS; j++) spots.push([EDGE + (i * (innerWidth - s - 2 * EDGE)) / (COLS - 1), EDGE + (j * (innerHeight - s - 2 * EDGE)) / (ROWS - 1)]);
    }
    spots.sort((a, b) => dist(a) - dist(b));
    const tryList = spots.slice(0, 14);
    if (keep && keep.s === s && dist([keep.x, keep.y]) < stay) tryList.unshift([keep.x, keep.y]);
    for (const [x, y] of tryList) {
      if (!rectFree(x, y, s, s, PAD, never)) continue;
      if (!withBubble) return { x, y, s, bubble: null, roam: true };
      const bubble = bubbleSpot(x, y, s, bw, bh, TIP_PAD, never);
      if (bubble) return { x, y, s, bubble, roam: true };
    }
  }
  return null;
}

/**
 * Mascot that roams the page with the scroll (always in a clear spot), reacts to visitors and shows a short tip.
 *
 *  trigger                                   reaction
 *  page opens                                waking, then idle after 2 s
 *  hover (tap on phones) on the main button  excited   (other buttons: their own pose, see BUTTONS)
 *  form sent                                 celebrate
 *  form error / invalid field                confused
 *  click or Enter on the mascot              laughing
 *  30 s with no mouse, scroll, touch, typing drowsy, then sleeping 10 s later; any activity → waking → idle
 *
 * Reactions are off when the visitor prefers reduced motion (or turned the site's animations off): the mascot
 * shows a still frame. Tips still show, they don't move anything.
 */
export function initMascot({ animate }) {
  const el = document.getElementById('mascot');
  if (!el) return;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const live = () => animate && !reduce.matches;
  const known = new Set(Object.keys(definition.animations));   // only names that exist in hkdevlab.avatar.json are ever played
  let avatar;
  try {
    avatar = createAvatar(el, {
      definition,
      ...(live() ? { defaultAnimation: 'waking' } : { defaultExpression: 'neutral' }),
      autoplay: live(),
      size: 120,
      ariaLabel: 'HK DevLab mascot',
      onAnimationEnd: () => react(),                           // a non-looping animation finished: pick what comes next
    });
  } catch (e) { console.error('[hkdevlab] mascot failed:', e); el.remove(); return; }
  el.classList.add('is-clear');
  el.tabIndex = 0; el.setAttribute('role', 'button'); el.setAttribute('aria-label', 'HK DevLab mascot. Click to make it laugh.');
  const tipEl = document.createElement('div');
  tipEl.className = 'mascot-tip';
  tipEl.setAttribute('aria-hidden', 'true');                   // the buttons already have their own labels
  el.after(tipEl);

  /* ───── what the visitor is doing ───── */
  const form = document.getElementById('form');
  const status = document.getElementById('formStatus');
  const submit = form && form.querySelector('button[type="submit"]');
  const sections = SECTIONS.map(([sel, mood, tip]) => ({ el: document.querySelector(sel), mood, tip }));
  let hovered = null; let focusedBtn = null; let lingerBtn = null; let lingerAt = 0; let tapTimer = 0;
  let section = null; let sectionAt = 0; let sectionPose = false;
  let typedAt = 0; let result = null; let resultTip = ''; let resultTimer = 0;
  let lastActive = Date.now(); let wakeUntil = Infinity; let wakeFromSleep = false; let opened = false; let laughUntil = 0;
  let tipWant = null; let lastRoam = null;

  const idleFor = () => Date.now() - lastActive;
  const startWake = (fromSleep) => { wakeUntil = Date.now() + WAKE_MS; wakeFromSleep = fromSleep; setTimeout(react, WAKE_MS + 50); };
  const poke = () => {                                         // any sign of life
    const was = idleFor();
    lastActive = Date.now();
    if (was >= DROWSY_MS) { startWake(true); react(); }
  };
  const activeBtn = () => {                                    // hovered / tapped / focused button, kept for a moment after you leave it
    const cur = hovered || focusedBtn;
    if (cur) { lingerBtn = cur; lingerAt = Date.now(); }
    const b = cur || (Date.now() - lingerAt < 800 ? lingerBtn : null);
    return b && b.isConnected && shown(b.getBoundingClientRect()) ? b : null;
  };
  const detectSection = () => {
    const mid = innerHeight / 2;
    const hit = sections.find((s) => { if (!s.el) return false; const r = s.el.getBoundingClientRect(); return r.top <= mid && r.bottom > mid; });
    if (hit && hit !== section) { sectionPose = section !== null; section = hit; sectionAt = Date.now(); }   // the first section is greeted by waking → idle, tip only
  };
  const wantMood = () => {
    const now = Date.now();
    if (result) return result;                                 // celebrate | confused
    if (submit && submit.getAttribute('aria-busy') === 'true') return 'working';
    if (form && form.querySelector('[aria-invalid="true"]')) return 'confused';
    if (laughUntil > now) return 'laughing';
    if (wakeUntil > now) return 'waking';
    if (idleFor() >= SLEEP_MS) return 'sleeping';
    if (idleFor() >= DROWSY_MS) return 'drowsy';
    if (now - typedAt < 1500) return 'thinking';
    if (document.activeElement && document.activeElement.matches(FIELD)) return 'listening';
    const b = activeBtn();
    if (b) return entryFor(b)[1];
    if (section && sectionPose && now - sectionAt < SECTION_MS) return section.mood;
    return 'idle';
  };
  const wantTip = () => {
    const now = Date.now();
    if (result) return resultTip;
    if (submit && submit.getAttribute('aria-busy') === 'true') return 'Sending…';
    if (laughUntil > now) return 'Hehe, that tickles!';
    if (wakeUntil > now && wakeFromSleep) return 'Oh, hi again!';
    if (idleFor() >= SLEEP_MS) return 'Zzz…';
    if (idleFor() >= DROWSY_MS) return 'Yawn… still there?';
    const b = activeBtn();
    if (b) return entryFor(b)[2];
    if (section && now - sectionAt < SECTION_MS) return section.tip;
    return null;
  };
  function update() {
    if (!opened && !document.getElementById('boot')) { opened = true; startWake(false); }   // page opened: waking, then idle
    if (opened) detectSection();
    el.classList.toggle('no-glide', !live());
    if (live() && !document.hidden) {
      const next = wantMood(); const st = avatar.getState();
      if (st.activeAnimation !== next || st.status !== 'playing') {   // switch, or resume/restart if it was paused/stopped
        if (known.has(next)) { el.dataset.mood = next; avatar.play(next); } else console.warn('[hkdevlab] mascot: no animation named', next);
      }
    }
    tipWant = wantTip();
    if (tipWant && tipWant !== tipEl.textContent) tipEl.textContent = tipWant;
  }

  /* ───── where ───── */
  const place = () => {
    if (document.hidden) return;
    let L = null;
    if (!document.getElementById('boot')) {
      const hb = activeBtn();
      const solve = (w, h, withBubble) => (hb && findLayout(hb, w, h, withBubble)) || roamLayout(w, h, withBubble, lastRoam);
      const shape = (cap) => { tipEl.style.maxWidth = cap; return [cap, tipEl.offsetWidth, tipEl.offsetHeight]; };   // wide one-liner, then a narrow two-liner
      if (tipWant) {
        for (const [cap, w, h] of [shape(''), shape('124px')]) {
          L = solve(w, h, true);
          if (L) { tipEl.style.maxWidth = cap; break; }
        }
      }
      L = L || solve(0, 0, false);
    }
    if (!L) { el.classList.add('is-clear'); tipEl.classList.remove('is-on'); return; }
    if (L.roam) lastRoam = L;

    const snapM = el.classList.contains('is-clear');           // appear in place, don't glide in from the last spot
    if (snapM) el.style.transition = 'opacity .25s';
    el.style.transform = `translate(${Math.round(L.x)}px, ${Math.round(L.y)}px) scale(${L.s / 120})`;
    el.classList.remove('is-clear');
    if (snapM) { void el.offsetWidth; el.style.transition = ''; }

    if (!tipWant || !L.bubble) { tipEl.classList.remove('is-on'); return; }
    const { side, x, y } = L.bubble;
    const snapT = !tipEl.classList.contains('is-on');
    if (snapT) tipEl.style.transition = 'opacity .25s';
    const horiz = side === 'left' || side === 'right';
    const tail = horiz ? L.y + L.s / 2 - y - 5 : L.x + L.s / 2 - x - 5;
    tipEl.dataset.side = side;
    tipEl.style.setProperty('--t', `${Math.max(12, Math.min((horiz ? tipEl.offsetHeight : tipEl.offsetWidth) - 22, tail))}px`);
    tipEl.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    tipEl.classList.add('is-on');
    if (snapT) { void tipEl.offsetWidth; tipEl.style.transition = ''; }
  };
  let timer = 0;
  const queue = () => { if (!timer) timer = setTimeout(() => { timer = 0; place(); }, 120); };   // at most ~8 layouts a second
  function react() { update(); queue(); }

  addEventListener('scroll', () => { poke(); react(); }, { passive: true });
  addEventListener('resize', react);
  ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart'].forEach((t) => addEventListener(t, poke, { passive: true }));
  setInterval(() => { update(); place(); }, 400);              // idle timers, reveals, pinned scenes: anything that changes without an event

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { if (avatar.getState().status === 'playing') avatar.pause(); } else react();   // resumes on return (update() sees "paused")
  });
  reduce.addEventListener('change', () => { if (!live()) avatar.stop(); react(); });                    // preference flipped while the page is open

  /* ───── buttons: hover with a mouse, tap on touch screens ───── */
  document.addEventListener('pointerover', (e) => { if (e.pointerType === 'touch') return; hovered = e.target.closest ? e.target.closest(BTN) : null; react(); });
  document.addEventListener('pointerout', (e) => {
    if (e.pointerType === 'touch') return;
    if (hovered && !(e.relatedTarget && hovered.contains(e.relatedTarget))) { hovered = null; react(); }
  });
  document.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    hovered = e.target.closest ? e.target.closest(BTN) : null;
    clearTimeout(tapTimer); tapTimer = setTimeout(() => { hovered = null; react(); }, TAP_MS);
    react();
  });
  document.addEventListener('focusin', (e) => { focusedBtn = e.target.closest(BTN); react(); });
  document.addEventListener('focusout', () => { focusedBtn = null; setTimeout(react, 0); });

  /* ───── the mascot itself ───── */
  const laugh = () => { laughUntil = Date.now() + LAUGH_MS; setTimeout(react, LAUGH_MS + 50); react(); };
  el.addEventListener('click', laugh);
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); laugh(); } });

  /* ───── the form ───── */
  if (form) form.addEventListener('input', () => { typedAt = Date.now(); react(); });
  if (status) {
    new MutationObserver(() => {
      const kind = status.dataset.kind;
      if (!status.textContent.trim() || (kind !== 'ok' && kind !== 'error')) return;
      result = kind === 'ok' ? 'celebrate' : 'confused';
      resultTip = kind === 'ok' ? 'Message sent. Thank you!' : "Hmm, that didn't go through. Try again?";
      clearTimeout(resultTimer);
      resultTimer = setTimeout(() => { result = null; react(); }, 6000);
      react();
    }).observe(status, { attributes: true, attributeFilter: ['data-kind'] });
  }

  react();
}
