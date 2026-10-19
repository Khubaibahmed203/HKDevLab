/**
 * The mascot renderer: builds HKDevLab's own SVG character inside an element and plays the poses and animations defined in
 * mascot-poses.js. ORIGINAL work for this site. All timing and geometry lives in mascot-core.js; this file only draws.
 *
 *   const avatar = createAvatar(el, { defaultAnimation: 'waking', autoplay: true, onAnimationEnd })
 *   avatar.play(name)  → true, or false for a name that does not exist
 *   avatar.pause()     keeps the current frame; avatar.play(sameName) then carries on from there
 *   avatar.stop()      shows the still resting pose
 *   avatar.getState()  → { status: 'stopped' | 'playing' | 'paused' | 'ended', activeAnimation }
 *
 * Performance: no filters, masks or images; a fixed 120 × 120 viewBox that the page scales with CSS; only attributes whose value changed are
 * written; at most ~40 frames a second; and the frame loop runs only while an animation is playing (a paused or still mascot costs nothing).
 * DOM, clock and frame scheduler are injectable (`doc`, `now`, `raf`, `caf`) so the tests can drive it without a browser.
 */
import { createPlayer, layout, GEO } from './mascot-core.js';
import { POSES, ANIMATIONS, PALETTE as C } from './mascot-poses.js';

const NS = 'http://www.w3.org/2000/svg';
const STAR = 'M0 -5 L1.4 -1.4 L5 0 L1.4 1.4 L0 5 L-1.4 1.4 L-5 0 L-1.4 -1.4 Z';
let instances = 0;                                   // gives every mascot its own gradient / clip ids

export function createAvatar(el, opts = {}) {
  const {
    defaultAnimation, defaultExpression = 'neutral', autoplay = true, onAnimationEnd,
    doc = globalThis.document, now = () => performance.now(), raf = (f) => requestAnimationFrame(f), caf = (id) => cancelAnimationFrame(id),
    fps = 40, rng = Math.random,
  } = opts;
  if (!el || !doc) throw new Error('createAvatar needs an element and a document');
  const uid = `hkm${++instances}`;

  const node = (tag, attrs = {}, parent) => { const n = doc.createElementNS(NS, tag); for (const k in attrs) n.setAttribute(k, attrs[k]); if (parent) parent.appendChild(n); return n; };
  /** A writer for one attribute that skips the DOM when the value has not changed. */
  const put = (n, name) => { let last; return (v) => { if (v !== last) { last = v; n.setAttribute(name, v); } }; };

  /* ───── the drawing ───── */
  const svg = node('svg', { viewBox: '0 0 120 120', width: '100%', height: '100%', 'aria-hidden': 'true', focusable: 'false' });
  if (svg.style) svg.style.display = 'block';
  const defs = node('defs', {}, svg);
  const body = node('linearGradient', { id: `${uid}-body`, x1: 0, y1: 0, x2: 1, y2: 1 }, defs);
  [[0, C.bodyA], [0.55, C.bodyB], [1, C.bodyC]].forEach(([o, c]) => node('stop', { offset: o, 'stop-color': c }, body));
  const eyeG = node('linearGradient', { id: `${uid}-eye`, x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
  [[0, C.eyeA], [1, C.eyeB]].forEach(([o, c]) => node('stop', { offset: o, 'stop-color': c }, eyeG));
  const clip = node('clipPath', { id: `${uid}-clip` }, defs);
  const V = GEO.visor, H = GEO.head;
  node('rect', { x: V.x, y: V.y, width: V.w, height: V.h, rx: V.r }, clip);

  const stage = node('g', { transform: `translate(0 ${GEO.stageY})` }, svg);   // a fixed drop, so even the highest bounce keeps the antenna inside the box
  const shadow = node('ellipse', { cx: 60, cy: 105, ry: 4, fill: C.shadow }, stage);
  const root = node('g', {}, stage);
  const ant = node('g', {}, root);
  node('line', { x1: 60, y1: GEO.antenna.base[1], x2: 60, y2: 13, stroke: C.pod, 'stroke-width': 3, 'stroke-linecap': 'round' }, ant);
  const halo = node('circle', { cx: 60, cy: GEO.antenna.tip[1], r: 8, fill: C.glow }, ant);
  node('circle', { cx: 60, cy: GEO.antenna.tip[1], r: 4, fill: C.eyeB, stroke: '#ffffff', 'stroke-opacity': 0.6, 'stroke-width': 0.8 }, ant);
  node('rect', { x: 9, y: 50, width: 9, height: 22, rx: 4.5, fill: C.pod }, root);
  node('rect', { x: 102, y: 50, width: 9, height: 22, rx: 4.5, fill: C.pod }, root);
  node('rect', { x: H.x, y: H.y, width: H.w, height: H.h, rx: H.r, fill: `url(#${uid}-body)`, stroke: '#ffffff', 'stroke-opacity': 0.16, 'stroke-width': 1.2 }, root);
  node('path', { d: 'M22 40 C24 30 40 24 62 25 C44 28 32 34 26 47 Z', fill: '#ffffff', 'fill-opacity': 0.14 }, root);
  node('rect', { x: V.x, y: V.y, width: V.w, height: V.h, rx: V.r, fill: C.visor, stroke: C.visorEdge, 'stroke-opacity': 0.55, 'stroke-width': 1.2 }, root);
  const clipped = node('g', { 'clip-path': `url(#${uid}-clip)` }, root);
  const face = node('g', {}, clipped);
  const eyes = ['L', 'R'].map(() => {
    const g = node('g', {}, face);
    return {
      eye: node('ellipse', { fill: `url(#${uid}-eye)` }, g),
      lid: node('rect', { fill: C.visor }, g),
      low: node('ellipse', { fill: C.visor }, g),
      lash: node('path', { fill: 'none', stroke: C.eyeB, 'stroke-width': 2.2, 'stroke-linecap': 'round' }, g),   // the shut-eye line, shown only when the lid is (nearly) down
      glow: node('ellipse', { fill: C.glow }, g),       // after the lids: a soft halo over everything, so a closed eye never shows a hard cut
    };
  });
  const cheeks = [36, 84].map((cx) => node('ellipse', { cx, cy: 64, rx: 6, ry: 3.6, fill: C.blush }, clipped));
  const mouth = node('path', { fill: C.mouthIn, stroke: C.mouth, 'stroke-width': 2.4, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, clipped);
  const zzz = GEO.zzz.map(() => { const t = node('text', { 'font-family': 'system-ui, sans-serif', 'font-size': 10, 'font-weight': 700, fill: C.zzz }, stage); t.textContent = 'z'; return t; });
  const sparks = GEO.sparks.map(() => node('path', { d: STAR, fill: C.spark }, stage));
  const dots = GEO.dots.map(([cx, cy]) => node('circle', { cx, cy, r: 2.2, fill: C.dot }, stage));
  el.appendChild(svg);

  /* one writer per attribute, created once */
  const W = {
    root: put(root, 'transform'), face: put(face, 'transform'), antT: put(ant, 'transform'), halo: put(halo, 'opacity'),
    shRx: put(shadow, 'rx'), shOp: put(shadow, 'opacity'),
    mT: put(mouth, 'transform'), mD: put(mouth, 'd'), mF: put(mouth, 'fill-opacity'),
    cheek: cheeks.map((c) => put(c, 'opacity')),
    eye: eyes.map((e) => ({
      cx: put(e.eye, 'cx'), cy: put(e.eye, 'cy'), rx: put(e.eye, 'rx'), ry: put(e.eye, 'ry'),
      lx: put(e.lid, 'x'), ly: put(e.lid, 'y'), lw: put(e.lid, 'width'), lh: put(e.lid, 'height'), lt: put(e.lid, 'transform'),
      ocx: put(e.low, 'cx'), ocy: put(e.low, 'cy'), orx: put(e.low, 'rx'), ory: put(e.low, 'ry'), oop: put(e.low, 'opacity'),
      sd: put(e.lash, 'd'), st: put(e.lash, 'transform'), so: put(e.lash, 'opacity'),
      gcx: put(e.glow, 'cx'), gcy: put(e.glow, 'cy'), grx: put(e.glow, 'rx'), gry: put(e.glow, 'ry'), gop: put(e.glow, 'opacity'),
    })),
    zzz: zzz.map((t) => ({ x: put(t, 'x'), y: put(t, 'y'), o: put(t, 'opacity') })),
    spark: sparks.map((s) => ({ t: put(s, 'transform'), o: put(s, 'opacity') })),
    dot: dots.map((d) => put(d, 'opacity')),
  };
  function render(f) {
    const l = layout(f.pose, f.amb, f.blink);
    W.root(l.root); W.face(l.face); W.antT(l.antenna.transform); W.halo(l.antenna.halo); W.shRx(l.shadow.rx); W.shOp(l.shadow.opacity);
    W.mT(l.mouth.transform); W.mD(l.mouth.d); W.mF(l.mouth.fillOpacity);
    W.cheek.forEach((w) => w(l.blush));
    l.eyes.forEach((e, i) => {
      const w = W.eye[i];
      w.cx(e.cx); w.cy(e.cy); w.rx(e.rx); w.ry(e.ry);
      w.lx(e.lidX); w.ly(e.lidY); w.lw(e.lidW); w.lh(e.lidH); w.lt(`rotate(${e.lidRot})`);
      w.ocx(e.lowCx); w.ocy(e.lowCy); w.orx(e.lowRx); w.ory(e.lowRy); w.oop(e.lowOn ? 1 : 0);
      w.sd(e.lash.d); w.st(`rotate(${e.lidRot})`); w.so(e.lash.opacity);
      w.gcx(e.cx); w.gcy(e.cy); w.grx(e.gx); w.gry(e.gy); w.gop(e.glowOp);
    });
    l.zzz.forEach((z, i) => { W.zzz[i].x(z.x); W.zzz[i].y(z.y); W.zzz[i].o(z.opacity); });
    l.sparks.forEach((s, i) => { W.spark[i].t(s.transform); W.spark[i].o(s.opacity); });
    l.dots.forEach((d, i) => W.dot[i](d.opacity));
  }

  /* ───── playback ───── */
  const rest = defaultExpression in POSES ? defaultExpression : 'neutral';
  const player = createPlayer({ poses: POSES, animations: ANIMATIONS, rng, rest, onEnd: (name) => { try { if (onAnimationEnd) onAnimationEnd(name); } catch (e) { console.error('[hkdevlab] mascot onAnimationEnd failed:', e); } } });
  let rafId = 0, lastDraw = -Infinity, destroyed = false;
  const draw = (t = now()) => render(player.frame(t));
  const cancel = () => { if (rafId) { caf(rafId); rafId = 0; } };
  const schedule = () => { if (!rafId && !destroyed && player.state().status === 'playing') rafId = raf(tick); };
  function tick() {
    rafId = 0;
    if (destroyed || player.state().status !== 'playing') return;
    const t = now();
    if (t - lastDraw >= 1000 / fps - 2) { lastDraw = t; draw(t); }     // may end a 'once' animation and call onAnimationEnd
    schedule();
  }

  if (autoplay && defaultAnimation && ANIMATIONS[defaultAnimation]) { player.play(defaultAnimation, now()); draw(); schedule(); }
  else draw();                                                         // a still pose; nothing is scheduled (reduced motion costs nothing)

  return {
    play(name) { if (destroyed || !player.play(name, now())) return false; draw(); schedule(); return true; },
    pause() { if (player.state().status === 'playing') { player.pause(now()); cancel(); } },
    stop() { player.stop(); cancel(); draw(); },
    getState() { return player.state(); },
    destroy() { destroyed = true; cancel(); if (svg.remove) svg.remove(); },
  };
}
