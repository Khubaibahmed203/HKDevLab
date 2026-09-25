/**
 * How much motion does this visitor get?
 *
 * The animated site is the product, so it is ON for everyone by default — including devices that have
 * "reduce motion" switched on (that setting is easy to enable by accident: battery saver, remote desktop,
 * low-power modes…). A visitor who really wants it off can turn it off from the footer (or the note shown
 * to reduce-motion devices), and that choice is remembered. `?motion=on` / `?motion=off` in the address
 * does the same thing, handy for testing on any device.
 */
const KEY = 'hk-motion';
const store = {
  get() { try { return localStorage.getItem(KEY); } catch (e) { return null; } },
  set(v) { try { localStorage.setItem(KEY, v); } catch (e) { /* private mode: the choice just isn't remembered */ } },
};

export function motionPlan() {
  const os = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let q = null;
  try { q = new URLSearchParams(location.search).get('motion'); } catch (e) { /* very old browser */ }
  if (q === 'on' || q === 'off') store.set(q);
  const pref = q === 'on' || q === 'off' ? q : store.get();
  return { on: pref !== 'off', os, pref };
}

function choose(value) {
  store.set(value);
  try {                                              // drop ?motion= so it cannot override the click after the reload
    const u = new URL(location.href);
    if (u.searchParams.has('motion')) { u.searchParams.delete('motion'); history.replaceState(null, '', u.pathname + u.search + u.hash); }
  } catch (e) { /* ignore */ }
  location.reload();
}

/** Footer switch (always) + a one-time note for devices that asked for reduced motion. */
export function initMotionUI({ on, os, pref }) {
  const toggle = document.getElementById('motionToggle');
  if (toggle) {
    toggle.hidden = false;
    toggle.textContent = on ? 'Animations: on' : 'Animations: off';
    toggle.setAttribute('aria-pressed', String(on));
    toggle.setAttribute('aria-label', on ? 'Animations are on. Turn animations off' : 'Animations are off. Turn animations on');
    toggle.addEventListener('click', () => choose(on ? 'off' : 'on'));
  }

  if (!os || pref) return;                           // only when the device asked for less motion and the visitor hasn't decided yet
  const pill = document.createElement('div');
  pill.className = 'motion-pill';
  pill.setAttribute('role', 'region');
  pill.setAttribute('aria-label', 'Animation setting');
  const msg = document.createElement('span');
  msg.textContent = 'This site is animated. Your device asks for reduced motion.';
  const off = document.createElement('button');
  off.type = 'button'; off.className = 'motion-pill__go'; off.textContent = 'Turn animations off';
  off.addEventListener('click', () => choose('off'));
  const keep = document.createElement('button');
  keep.type = 'button'; keep.className = 'motion-pill__x'; keep.textContent = '×'; keep.setAttribute('aria-label', 'Keep animations on');
  keep.addEventListener('click', () => { store.set('on'); pill.remove(); });   // remembered, so it is not shown again
  pill.append(msg, off, keep);
  document.body.append(pill);
}
