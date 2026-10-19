/**
 * Mascot logic with no DOM: easing, pose blending, animation timelines, blinking, ambient motion, the play/pause/stop state machine and the
 * geometry that turns a pose into concrete SVG numbers. ORIGINAL work for this site. The renderer (mascot-engine.js) only applies what this
 * module computes, so everything here can be tested in plain Node (server/test-mascot.mjs).
 */

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const lerp = (a, b, t) => a + (b - a) * t;
/** Smooth start and finish (smoothstep). */
export const ease = (t) => { const x = clamp(t, 0, 1); return x * x * (3 - 2 * x); };
/** Blends two poses field by field (t = 0 → a, t = 1 → b). */
export const mixPose = (a, b, t) => { const out = {}; for (const k in a) out[k] = lerp(a[k], k in b ? b[k] : a[k], t); return out; };

/* ───────────── timelines ───────────── */

export const totalMs = (anim) => anim.steps.reduce((sum, st) => sum + st.blend + st.hold, 0);

/**
 * The pose `elapsed` ms into an animation. Each step eases into its pose over `blend` ms and then holds it for `hold` ms. The first step
 * eases from `from` (what the mascot looked like when the animation started); on later laps a loop eases from its own last step.
 * A 'once' animation stops on its last pose and reports done.
 */
export function sampleAnimation(anim, poses, elapsed, from) {
  const total = totalMs(anim), steps = anim.steps, last = steps.length - 1;
  let t = Math.max(0, elapsed), lap = 0, done = false;
  if (anim.mode === 'once') { if (t >= total) { done = true; t = total; } }
  else { lap = Math.floor(t / total); t -= lap * total; }
  let prev = lap === 0 ? from : poses[steps[last].pose], start = 0;
  for (let i = 0; i <= last; i++) {
    const st = steps[i], target = poses[st.pose], end = start + st.blend + st.hold;
    if (t < end || i === last) {
      const into = t - start;
      return { pose: into < st.blend ? mixPose(prev, target, ease(into / st.blend)) : target, done, index: i };
    }
    prev = target; start = end;
  }
  return { pose: poses[steps[last].pose], done, index: last };    // not reachable; keeps the return type total
}

/* ───────────── blinking and ambient motion ───────────── */

/** 0 → 1 → 0 over `dur` ms starting at 0; 0 outside that window. */
export const blinkAmount = (since, dur) => (since < 0 || since >= dur ? 0 : 1 - Math.abs((2 * since) / dur - 1));
export const nextBlinkDelay = (rng, cfg) => lerp(cfg.min, cfg.max, rng());

const TAU = Math.PI * 2;
/** Small continuous motion on top of the pose, plus the phases that drive the "zzz", sparkles and dots. */
export function ambient(m, t) {
  const out = { dy: 0, rot: 0, sy: 1, zp: (t / 2600) % 1, sp: t / 420, dp: (t / 1100) % 1 };
  if (!m) return out;
  const wave = (c) => (c ? Math.sin((t / 1000) * c.hz * TAU) : 0);
  out.dy = -(m.float ? m.float.amp * wave(m.float) : 0) - (m.bounce ? m.bounce.amp * Math.abs(wave(m.bounce)) : 0);
  out.rot = m.sway ? m.sway.deg * wave(m.sway) : 0;
  out.sy = 1 + (m.breathe ? m.breathe.amp * wave(m.breathe) : 0);
  return out;
}

/* ───────────── the player: play / pause / resume / stop ───────────── */

/**
 * A clock-driven state machine. `status` is 'stopped' | 'playing' | 'paused' | 'ended'; `activeAnimation` is the name last played (null after
 * stop). frame(now) returns what to draw. `now` is any millisecond clock, passed in, so tests can drive time by hand.
 */
export function createPlayer({ poses, animations, rng = Math.random, onEnd = () => {}, rest = 'neutral' }) {
  let status = 'stopped', name = null, base = 0, t0 = 0, from = poses[rest], last = poses[rest], nextBlink = Infinity, blinkAt = -Infinity;
  const elapsed = (now) => base + (status === 'playing' ? now - t0 : 0);
  const restFrame = () => ({ pose: poses[rest], amb: ambient(null, 0), blink: 0 });

  return {
    play(n, now) {
      const anim = animations[n];
      if (!anim) return false;
      if (status === 'paused' && name === n) { t0 = now; status = 'playing'; return true; }      // same mood after a pause: carry on, don't restart
      from = last; name = n; status = 'playing'; base = 0; t0 = now; blinkAt = -Infinity;
      nextBlink = anim.blink ? nextBlinkDelay(rng, anim.blink) : Infinity;
      return true;
    },
    pause(now) { if (status === 'playing') { base = elapsed(now); status = 'paused'; } },
    stop() { status = 'stopped'; name = null; base = 0; last = poses[rest]; from = poses[rest]; nextBlink = Infinity; },
    state() { return { status, activeAnimation: name }; },
    /** The pose, ambient motion and blink amount at `now` (the last pose, frozen, while paused or ended). */
    frame(now) {
      if (!name) return restFrame();
      const anim = animations[name], t = elapsed(now), s = sampleAnimation(anim, poses, t, from);
      last = s.pose;
      let blink = 0;
      if (anim.blink) {
        while (t >= nextBlink) { blinkAt = nextBlink; nextBlink = blinkAt + anim.blink.dur + nextBlinkDelay(rng, anim.blink); }
        blink = blinkAmount(t - blinkAt, anim.blink.dur);
      }
      if (s.done && status === 'playing') { base = t; status = 'ended'; onEnd(name); }
      return { pose: s.pose, amb: ambient(anim.motion, t), blink };
    },
  };
}

/* ───────────── geometry ───────────── */

/** Where things sit inside the 120 × 120 drawing. The visor is the dark face plate; the face is clipped to it. */
export const GEO = {
  head: { x: 14, y: 24, w: 92, h: 74, r: 28 },
  visor: { x: 24, y: 36, w: 72, h: 48, r: 22 },
  eyeY: 52, mouthY: 70, pivot: [60, 98], stageY: 10,
  antenna: { base: [60, 24], tip: [60, 9] },
  sparks: [[12, 28], [108, 32], [9, 78], [111, 72], [90, 10], [30, 9]],
  dots: [[88, 30], [96, 30], [104, 30]],
  zzz: [[86, 30], [95, 21], [104, 13]],
};

const r2 = (v) => Math.round(v * 100) / 100;

/**
 * Turns a pose (+ ambient motion + current blink) into the exact numbers the renderer writes: transforms, ellipse radii, the lid rectangles
 * and the mouth path. The eyelids are drawn in the visor colour over each eye, so no masks or filters are needed.
 */
export function layout(p, amb, blink) {
  const sy = p.sy * amb.sy;
  const eyes = [['L', -1, p.eL, p.uL, p.lL, p.tL], ['R', 1, p.eR, p.uR, p.lR, -p.tR]].map(([, side, k, u0, l, tilt]) => {
    const cx = 60 + side * p.es, cy = GEO.eyeY + p.ey, rx = p.ew / 2, ry = (p.eh * k) / 2;
    const u = u0 + (1 - u0) * blink;                                        // a blink closes the upper lid the rest of the way
    const lidH = p.eh * k * 1.5, lidW = p.ew * 2.6, lidBottom = cy - ry + u * 2 * ry;
    const lowRy = ry * 0.9, lowTop = cy + ry - l * ry * 1.5;
    const covered = clamp(Math.max(u, l * 0.85), 0, 1);                      // how much of the eye the lids hide
    return {
      // the halo is drawn ABOVE the lids (no hard cut), and fades out as the eye closes so a shut or smiling eye is not ringed by a dark circle
      cx: r2(cx), cy: r2(cy), rx: r2(rx), ry: r2(ry), gx: r2(rx * 1.55), gy: r2(ry * 1.35), glowOp: r2((0.07 + 0.13 * p.glow) * (1 - covered) ** 2),
      // a curved lash line on the lid's edge once the eye is (nearly) shut, so closed eyes read as closed rather than as holes
      lash: { d: `M ${r2(cx - rx * 0.95)} ${r2(lidBottom)} Q ${r2(cx)} ${r2(lidBottom + 3)} ${r2(cx + rx * 0.95)} ${r2(lidBottom)}`, opacity: r2(clamp((u - 0.6) * 2.5, 0, 1)) },
      lidX: r2(cx - lidW / 2), lidY: r2(lidBottom - lidH), lidW: r2(lidW), lidH: r2(lidH), lidRot: `${r2(tilt)} ${r2(cx)} ${r2(cy)}`,
      lowCx: r2(cx), lowCy: r2(lowTop + lowRy), lowRx: r2(rx * 1.35), lowRy: r2(lowRy), lowOn: l > 0.02,
    };
  });
  const mid = 2 * p.mc, low = 2 * (p.mc + p.mo);
  return {
    root: `translate(${r2(p.dx)} ${r2(p.dy + amb.dy)}) rotate(${r2(p.tilt + amb.rot)} ${GEO.pivot[0]} ${GEO.pivot[1]}) matrix(1 0 0 ${r2(sy)} 0 ${r2(GEO.pivot[1] * (1 - sy))})`,
    face: `translate(${r2(p.gx)} ${r2(p.gy)})`,
    eyes,
    mouth: { transform: `translate(${r2(60 + p.gx * 0.35)} ${r2(GEO.mouthY + p.my + p.gy * 0.35)})`, d: `M ${r2(-p.mw)} 0 Q 0 ${r2(mid)} ${r2(p.mw)} 0 Q 0 ${r2(low)} ${r2(-p.mw)} 0 Z`, fillOpacity: r2(clamp(p.mo / 3, 0, 1)), bottom: r2(GEO.mouthY + p.my + p.gy * 0.35 + p.mc + p.mo) },
    blush: r2(p.blush * 0.55),
    antenna: { transform: `rotate(${r2(p.ant)} ${GEO.antenna.base[0]} ${GEO.antenna.base[1]})`, halo: r2(0.12 + p.glow * 0.4) },
    shadow: { rx: r2(Math.max(16, 26 + Math.min(0, p.dy + amb.dy) * 0.5)), opacity: r2(Math.max(0.12, 0.28 + Math.min(0, p.dy + amb.dy) * 0.012)) },   // the higher the head lifts, the smaller and fainter its shadow
    // extras that are switched off are parked, not animated, so they cost no attribute writes
    zzz: GEO.zzz.map(([x, y], i) => { if (p.zzz <= 0) return { x, y, opacity: 0 }; const ph = (amb.zp + i / 3) % 1; return { x: r2(x + ph * 4), y: r2(y - ph * 6), opacity: r2(p.zzz * Math.sin(ph * Math.PI)) }; }),
    sparks: GEO.sparks.map(([x, y], i) => { if (p.spark <= 0) return { transform: `translate(${x} ${y}) scale(0)`, opacity: 0 }; const k = 0.65 + 0.35 * Math.sin(amb.sp + i * 1.7); return { transform: `translate(${x} ${y}) rotate(${r2((amb.sp * 20 + i * 40) % 90)}) scale(${r2(p.spark * k)})`, opacity: r2(p.spark) }; }),
    dots: GEO.dots.map(([x, y], i) => { const ph = (amb.dp - i / 3 + 1) % 1; return { cx: x, cy: y, opacity: r2(p.dots * (0.25 + 0.75 * Math.max(0, Math.sin(ph * Math.PI)))) }; }),
  };
}
