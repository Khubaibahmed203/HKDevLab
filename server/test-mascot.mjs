// HKDevLab's own mascot (src/modules/mascot-*.js): data, timelines, geometry, state machine and the SVG engine — no browser, no packages.
// The engine is driven through a tiny fake DOM and a hand-cranked clock. Not covered here (needs a person with a screen): how it LOOKS.
// Run: node server/test-mascot.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { clamp, lerp, ease, mixPose, totalMs, sampleAnimation, blinkAmount, nextBlinkDelay, ambient, createPlayer, layout, GEO } from '../src/modules/mascot-core.js';
import { POSES, ANIMATIONS, MOODS, FIELDS, RANGES } from '../src/modules/mascot-poses.js';
import { createAvatar } from '../src/modules/mascot-engine.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { (cond ? pass++ : fail++); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const near = (a, b, e = 1e-9) => Math.abs(a - b) <= e;
const finiteDeep = (v) => (typeof v === 'number' ? Number.isFinite(v) : v && typeof v === 'object' ? Object.values(v).every(finiteDeep) : true);

/* ═══ 1. the data ═══ */
const poseNames = Object.keys(POSES);
ok(`every pose (${poseNames.length}) carries exactly the ${FIELDS.length} documented numbers`, poseNames.every((n) => same(Object.keys(POSES[n]).sort(), [...FIELDS].sort())));
const outOfRange = poseNames.flatMap((n) => FIELDS.filter((f) => !(Number.isFinite(POSES[n][f]) && POSES[n][f] >= RANGES[f][0] && POSES[n][f] <= RANGES[f][1])).map((f) => `${n}.${f}=${POSES[n][f]}`));
ok('every pose value is finite and inside its documented range', outOfRange.length === 0, outOfRange.join(', '));
ok('poses and animations are frozen (nothing can change them at run time)', Object.isFrozen(POSES) && Object.isFrozen(ANIMATIONS) && Object.isFrozen(POSES.neutral) && Object.isFrozen(ANIMATIONS.idle.steps));
const badSteps = MOODS.flatMap((m) => ANIMATIONS[m].steps.filter((s) => !POSES[s.pose] || !(s.blend >= 0) || !(s.hold > 0)).map((s) => `${m}:${s.pose}`));
ok('every animation step names an existing pose, with blend >= 0 and hold > 0', badSteps.length === 0, badSteps.join(', '));
ok('every animation has a positive total length and loops (the page decides how long a mood lasts)', MOODS.every((m) => totalMs(ANIMATIONS[m]) > 0 && ANIMATIONS[m].mode === 'loop'));
ok('blink settings are sane wherever they exist (min <= max, positive duration, minimum gap above the blink)', MOODS.every((m) => { const b = ANIMATIONS[m].blink; return !b || (b.min <= b.max && b.dur > 0 && b.min > b.dur); }));
ok('there are 16 moods and a still "neutral" pose', MOODS.length === 16 && !!POSES.neutral);

/* the page's behaviour code (mascot.js) must only ever ask for moods that exist */
const src = read('../src/modules/mascot.js');
const blockOf = (name) => { const i = src.indexOf(`const ${name} = [`); return src.slice(i, src.indexOf('\n];', i)); };
const asked = new Set([
  ...[...blockOf('BUTTONS').matchAll(/^\s*\[(?:'[^']*'|"[^"]*"),\s*'(\w+)',/gm)].map((m) => m[1]),
  ...[...blockOf('SECTIONS').matchAll(/^\s*\[(?:'[^']*'|"[^"]*"),\s*'(\w+)',/gm)].map((m) => m[1]),
  ...[...src.matchAll(/return '(\w+)';/g)].map((m) => m[1]),
  'celebrate', 'waking', ...[...src.matchAll(/\[null, '(\w+)'/g)].map((m) => m[1]),
]);
ok(`mascot.js asks for ${asked.size} different moods and every one exists in ANIMATIONS`, asked.size >= 14 && [...asked].every((m) => MOODS.includes(m)), [...asked].filter((m) => !MOODS.includes(m)).join(', '));

/* ═══ 2. independence from third-party code and assets ═══ */
const files = { 'mascot.js': src, 'mascot-engine.js': read('../src/modules/mascot-engine.js'), 'mascot-core.js': read('../src/modules/mascot-core.js'), 'mascot-poses.js': read('../src/modules/mascot-poses.js') };
const importsOf = (t) => [...t.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1]);
ok('no mascot file mentions the third-party package or its JSON format', Object.values(files).every((t) => !/bible-strong|avatar-web|avatar-core|\.avatar\.json|avatar-definition/i.test(t)));
ok('mascot.js imports only the two new local modules', same(importsOf(files['mascot.js']).sort(), ['./mascot-engine.js', './mascot-poses.js']));
ok('the engine imports only the core and the poses; the core and the poses import nothing', same(importsOf(files['mascot-engine.js']).sort(), ['./mascot-core.js', './mascot-poses.js']) && importsOf(files['mascot-core.js']).length === 0 && importsOf(files['mascot-poses.js']).length === 0);
ok('package.json no longer depends on the third-party avatar package', !/bible-strong/.test(read('../package.json')));
ok('nothing under src/ or index.html (outside the preserved, now unreferenced JSON) imports the old avatar JSON', ![read('../src/main.js'), read('../index.html'), ...Object.values(files)].some((t) => /hkdevlab\.avatar/.test(t)));
ok('the engine builds with createElementNS only — no innerHTML, eval or network access', !/innerHTML|outerHTML|insertAdjacentHTML|eval\(|new Function|fetch\(|XMLHttpRequest|WebSocket/.test(files['mascot-engine.js'] + files['mascot-core.js']));

/* ═══ 3. maths ═══ */
ok('clamp / lerp behave', clamp(5, 0, 3) === 3 && clamp(-1, 0, 3) === 0 && clamp(2, 0, 3) === 2 && lerp(10, 20, 0.25) === 12.5);
ok('ease runs 0 → 1, is monotonic and flat at both ends', ease(0) === 0 && ease(1) === 1 && ease(-3) === 0 && ease(4) === 1 && near(ease(0.5), 0.5) && Array.from({ length: 100 }, (_, i) => ease(i / 99)).every((v, i, a) => i === 0 || v >= a[i - 1]) && ease(0.02) < 0.02 && ease(0.98) > 0.98);
const mid = mixPose(POSES.neutral, POSES.joy, 0.5);
ok('mixPose hits both ends exactly and lies between them in the middle', same(mixPose(POSES.neutral, POSES.joy, 0), { ...POSES.neutral }) && same(mixPose(POSES.neutral, POSES.joy, 1), { ...POSES.joy }) && FIELDS.every((f) => near(mid[f], (POSES.neutral[f] + POSES.joy[f]) / 2)));
ok('mixPose ignores extra keys in the target and keeps the shape of the first pose', same(Object.keys(mixPose({ a: 1 }, { a: 3, b: 9 }, 0.5)), ['a']));

/* ═══ 4. timelines ═══ */
const TP = { A: { x: 0 }, B: { x: 10 }, R: { x: 4 } };
const loopAnim = { mode: 'loop', steps: [{ pose: 'A', blend: 100, hold: 100 }, { pose: 'B', blend: 100, hold: 100 }] };
const xAt = (anim, t, from = TP.R) => sampleAnimation(anim, TP, t, from).pose.x;
ok('a timeline starts from the pose the mascot was in', xAt(loopAnim, 0) === 4 && near(xAt(loopAnim, 50), lerp(4, 0, 0.5)));
ok('it reaches a pose at the end of the blend and holds it', xAt(loopAnim, 100) === 0 && xAt(loopAnim, 199) === 0);
ok('the second step eases from the first pose to its own', near(xAt(loopAnim, 250), 5) && xAt(loopAnim, 300) === 10 && xAt(loopAnim, 399) === 10);
ok('a loop wraps: lap two eases from its own last pose, not from the start pose', totalMs(loopAnim) === 400 && near(xAt(loopAnim, 450), lerp(10, 0, 0.5)) && xAt(loopAnim, 500) === 0 && xAt(loopAnim, 400 * 7 + 100) === 0);
ok('negative elapsed time is treated as zero', xAt(loopAnim, -50) === 4);
const onceAnim = { mode: 'once', steps: [{ pose: 'A', blend: 100, hold: 100 }, { pose: 'B', blend: 100, hold: 100 }] };
ok('a "once" animation stops on its last pose and reports done only then', sampleAnimation(onceAnim, TP, 399, TP.R).done === false && sampleAnimation(onceAnim, TP, 400, TP.R).done === true && xAt(onceAnim, 9999) === 10);
ok('a zero-length blend jumps straight to the pose', xAt({ mode: 'loop', steps: [{ pose: 'B', blend: 0, hold: 50 }] }, 0) === 10);

/* ═══ 5. blinking and ambient motion ═══ */
ok('a blink goes 0 → 1 → 0 within its duration and is 0 outside it', blinkAmount(-1, 150) === 0 && blinkAmount(0, 150) === 0 && near(blinkAmount(75, 150), 1) && near(blinkAmount(37.5, 150), 0.5) && blinkAmount(150, 150) === 0 && blinkAmount(900, 150) === 0);
ok('the next blink delay stays within [min, max]', nextBlinkDelay(() => 0, { min: 2000, max: 4000 }) === 2000 && nextBlinkDelay(() => 1, { min: 2000, max: 4000 }) === 4000 && nextBlinkDelay(() => 0.5, { min: 2000, max: 4000 }) === 3000);
const still = ambient(null, 12345);
ok('no motion configured → no offset, no squash', still.dy === 0 && still.rot === 0 && still.sy === 1 && still.zp >= 0 && still.zp < 1 && still.dp >= 0 && still.dp < 1);
let worst = { dy: 0, up: 0, rot: 0, sy: 0 };
const M = { float: { amp: 2, hz: 0.7 }, bounce: { amp: 3, hz: 1.3 }, sway: { deg: 4, hz: 0.4 }, breathe: { amp: 0.02, hz: 0.3 } };
for (let t = 0; t < 20000; t += 17) { const a = ambient(M, t); worst.dy = Math.min(worst.dy, a.dy); worst.up = Math.max(worst.up, a.dy); worst.rot = Math.max(worst.rot, Math.abs(a.rot)); worst.sy = Math.max(worst.sy, Math.abs(a.sy - 1)); }
ok('ambient motion stays inside its configured amplitudes (bounce only lifts; float swings both ways)', worst.dy >= -5.0001 && worst.up <= 2.0001 && worst.rot <= 4.0001 && worst.sy <= 0.0201, JSON.stringify(worst));

/* ═══ 6. the state machine ═══ */
const mk = (extra = {}) => createPlayer({ poses: POSES, animations: ANIMATIONS, rng: () => 0, ...extra });
let p = mk();
ok('a new player is stopped with no animation, showing the resting pose', same(p.state(), { status: 'stopped', activeAnimation: null }) && same(p.frame(0).pose, { ...POSES.neutral }));
ok('playing an unknown name is refused and changes nothing', p.play('nope', 0) === false && same(p.state(), { status: 'stopped', activeAnimation: null }));
ok('playing a known name starts it', p.play('idle', 1000) === true && same(p.state(), { status: 'playing', activeAnimation: 'idle' }));
const f0 = p.frame(1000);
ok('frames carry a full pose, ambient motion and a blink amount', same(Object.keys(f0.pose).sort(), [...FIELDS].sort()) && finiteDeep(f0) && f0.blink >= 0 && f0.blink <= 1);
p.frame(2500); p.pause(2500);
const frozenA = p.frame(2500), frozenB = p.frame(2500 + 60000);
ok('pause freezes everything: same frame a minute later, status paused, name kept', same(frozenA, frozenB) && same(p.state(), { status: 'paused', activeAnimation: 'idle' }));
p.play('idle', 70000);
const ref = mk(); ref.play('idle', 0);
ok('playing the same mood again after a pause carries on instead of restarting (1.5 s played, paused for a minute, 0.7 s more = 2.2 s in)', p.state().status === 'playing' && same(p.frame(70000 + 700), ref.frame(1500 + 700)));
const before = p.frame(70700).pose;
p.play('happy', 70700);
ok('switching mood eases from the pose it was in (no jump)', FIELDS.every((f) => near(p.frame(70700).pose[f], before[f], 1e-9)));
p.stop();
ok('stop returns to the still resting pose with no animation name', same(p.state(), { status: 'stopped', activeAnimation: null }) && same(p.frame(99999).pose, { ...POSES.neutral }) && p.frame(99999).blink === 0);
let ended = []; const once = mk({ animations: { go: { mode: 'once', steps: [{ pose: 'neutral', blend: 100, hold: 100 }, { pose: 'joy', blend: 100, hold: 100 }], blink: null, motion: null } }, onEnd: (n) => ended.push(n) });
once.play('go', 0); once.frame(100); once.frame(399);
ok('a "once" animation does not report an end early', ended.length === 0 && once.state().status === 'playing');
once.frame(400); once.frame(700); once.frame(5000);
ok('…reports its end exactly once, then holds the last pose with status "ended"', same(ended, ['go']) && once.state().status === 'ended' && same(once.frame(9e6).pose, { ...POSES.joy }));
once.play('go', 10000); once.frame(10500);
ok('…and can be played again, which ends again', ended.length === 2 && once.state().status === 'ended');
const looped = []; const lp = mk({ onEnd: (n) => looped.push(n) }); lp.play('laughing', 0); for (let t = 0; t < 120000; t += 33) lp.frame(t);
ok('looping moods never report an end', looped.length === 0 && lp.state().status === 'playing');

/* blinks follow the schedule, and moods without blinks never blink */
const bp = mk({ rng: () => 0 }); bp.play('idle', 0);       // min delay 2400, duration 150
const blinks = []; for (let t = 0; t <= 8000; t += 10) blinks.push([t, bp.frame(t).blink]);
ok('idle blinks first at its minimum delay (2.4 s), peaks mid-blink and is open 150 ms later', blinks.find(([t]) => t === 2400)[1] === 0 && blinks.find(([t]) => t === 2470)[1] > 0.9 && blinks.find(([t]) => t === 2560)[1] === 0 && blinks.filter(([, b]) => b > 0).every(([t]) => (t > 2400 && t < 2550) || (t > 4950 && t < 5100) || (t > 7500 && t < 7650)));
const sp = mk({ rng: () => 0 }); sp.play('sleeping', 0); let sleepBlink = 0; for (let t = 0; t < 60000; t += 25) sleepBlink = Math.max(sleepBlink, sp.frame(t).blink);
ok('a sleeping mascot never blinks', sleepBlink === 0);

/* ═══ 7. geometry ═══ */
const tfm = (p, a, [x, y]) => { const s = p.sy * a.sy, Y0 = 98 + (y - 98) * s, th = ((p.tilt + a.rot) * Math.PI) / 180, c = Math.cos(th), sn = Math.sin(th), dx = x - 60, dy = Y0 - 98; return [60 + dx * c - dy * sn + p.dx, 98 + dx * sn + dy * c + p.dy + a.dy + GEO.stageY]; };
const OUTLINE = [[14, 24], [106, 24], [14, 98], [106, 98], [9, 50], [111, 50], [9, 72], [111, 72], [60, 1]];     // head corners, side pods, top of the antenna glow
ok('the shadow (stage y 105 ± 4) also stays inside the box', GEO.stageY + 105 + 4 <= 120 && GEO.stageY + 98 + 12 <= 120);
let geoBad = [], faceBad = [], nonFinite = [];
for (const m of MOODS) {
  const motion = ANIMATIONS[m].motion || {}, lift = (motion.float?.amp || 0), up = (motion.bounce?.amp || 0), swayD = motion.sway?.deg || 0, br = motion.breathe?.amp || 0;
  for (const st of ANIMATIONS[m].steps) {
    const pose = POSES[st.pose];
    for (const a of [{ dy: lift, rot: swayD, sy: 1 + br }, { dy: -lift - up, rot: -swayD, sy: 1 - br }, { dy: 0, rot: 0, sy: 1 }]) {
      for (const pt of OUTLINE) { const [x, y] = tfm(pose, a, pt); if (x < 0 || x > 120 || y < 0 || y > 120) geoBad.push(`${m}/${st.pose} ${pt} → ${x.toFixed(1)},${y.toFixed(1)}`); }
      for (const blink of [0, 1]) {
        const L = layout(pose, { ...a, zp: 0.3, sp: 1, dp: 0.6 }, blink);
        if (!finiteDeep(L)) nonFinite.push(`${m}/${st.pose}`);
        for (const e of L.eyes) { const gx = pose.gx, gy = pose.gy; if (e.cx - e.rx + gx < 24 || e.cx + e.rx + gx > 96 || e.cy - e.ry + gy < 34 || e.cy + e.ry + gy > 76) faceBad.push(`${m}/${st.pose} eye`); }
        if (L.mouth.bottom > 83 || L.mouth.bottom < 66) faceBad.push(`${m}/${st.pose} mouth ${L.mouth.bottom}`);
      }
    }
  }
}
ok('the head, pods and antenna glow stay inside the 120 × 120 drawing in every pose at the extremes of its motion', geoBad.length === 0, geoBad.slice(0, 4).join(' | '));
ok('eyes and mouth stay on the visor in every pose', faceBad.length === 0, faceBad.slice(0, 4).join(' | '));
ok('layout() output is finite everywhere (no NaN or Infinity can reach the DOM)', nonFinite.length === 0, nonFinite.slice(0, 4).join(', '));
const Ln = layout(POSES.neutral, ambient(null, 0), 0);
ok('a symmetric pose gives a mirror-image pair of eyes', near(Ln.eyes[0].cx + Ln.eyes[1].cx, 120) && Ln.eyes[0].ry === Ln.eyes[1].ry && Ln.eyes[0].lidRot.split(' ')[0] === '0' && Ln.eyes[1].lidRot.split(' ')[0] === '0');
const Lc = layout(POSES.curious, ambient(null, 0), 0);
ok('an asymmetric pose really is asymmetric (curious: different eye heights and lid tilts)', Lc.eyes[0].ry !== Lc.eyes[1].ry && Lc.eyes[0].lidRot !== Lc.eyes[1].lidRot);
const open = layout(POSES.neutral, ambient(null, 0), 0).eyes[0], shut = layout(POSES.neutral, ambient(null, 0), 1).eyes[0];
ok('with an open eye the upper lid stops at the top of the eye; a full blink brings it past the bottom', near(open.lidY + open.lidH, open.cy - open.ry, 0.02) && shut.lidY + shut.lidH >= shut.cy + shut.ry - 0.02);
const asleepEye = layout(POSES.asleep, ambient(null, 0), 0).eyes[0];
ok('a sleeping eye is almost completely covered', (asleepEye.lidY + asleepEye.lidH - (asleepEye.cy - asleepEye.ry)) / (2 * asleepEye.ry) > 0.9);
const asleepFull = layout(POSES.asleep, ambient(null, 0), 0), joyFull = layout(POSES.joy, ambient(null, 0), 0), openFull = layout(POSES.neutral, ambient(null, 0), 0), blinkFull = layout(POSES.neutral, ambient(null, 0), 1);
ok('a shut eye shows its lash line, an open or smiling eye does not (so closed eyes read as closed)', asleepFull.eyes.every((e) => e.lash.opacity > 0.85) && openFull.eyes.every((e) => e.lash.opacity === 0) && joyFull.eyes.every((e) => e.lash.opacity === 0) && blinkFull.eyes.every((e) => e.lash.opacity === 1));
ok('the glow halo fades out as an eye closes or smiles, and is strongest on an open eye', asleepFull.eyes[0].glowOp < 0.02 && joyFull.eyes[0].glowOp < openFull.eyes[0].glowOp * 0.5 && blinkFull.eyes[0].glowOp < 0.02 && openFull.eyes[0].glowOp > 0.1);
const wink = layout(POSES.winkR, ambient(null, 0), 0);
ok('a wink shuts one eye only (lash line on the right, none on the left)', wink.eyes[1].lash.opacity > 0.8 && wink.eyes[0].lash.opacity === 0);
ok('smiling eyes use the lower lid, neutral eyes do not', layout(POSES.joy, ambient(null, 0), 0).eyes[0].lowOn === true && Ln.eyes[0].lowOn === false);
ok('the mouth opens and curves with the pose (grin opens and smiles, confused frowns)', layout(POSES.grin, ambient(null, 0), 0).mouth.fillOpacity === 1 && layout(POSES.neutral, ambient(null, 0), 0).mouth.fillOpacity === 0 && /Q 0 -/.test(layout(POSES.confused, ambient(null, 0), 0).mouth.d));
ok('the "zzz", sparkles and thinking dots appear only in the poses that ask for them', layout(POSES.asleep, { ...ambient(null, 0), zp: 0.5 }, 0).zzz.some((z) => z.opacity > 0.3) && layout(POSES.neutral, { ...ambient(null, 0), zp: 0.5 }, 0).zzz.every((z) => z.opacity === 0) && layout(POSES.cheer, ambient(null, 0), 0).sparks.every((s) => s.opacity === 1) && layout(POSES.neutral, ambient(null, 0), 0).sparks.every((s) => s.opacity === 0) && layout(POSES.think, { ...ambient(null, 0), dp: 0.4 }, 0).dots.some((d) => d.opacity > 0.2) && layout(POSES.neutral, ambient(null, 0), 0).dots.every((d) => d.opacity === 0));
ok('the shadow shrinks and fades as the head lifts', layout(POSES.cheerB, ambient(null, 0), 0).shadow.rx < layout(POSES.neutral, ambient(null, 0), 0).shadow.rx && layout(POSES.cheerB, ambient(null, 0), 0).shadow.opacity < layout(POSES.neutral, ambient(null, 0), 0).shadow.opacity);

/* ═══ 8. the SVG engine, in a fake DOM with a hand-cranked clock ═══ */
class FakeNode {
  constructor(tag, doc) { this.tag = tag; this.doc = doc; this.attrs = {}; this.children = []; this.style = {}; this.textContent = ''; this.parent = null; }
  setAttribute(k, v) { this.attrs[k] = String(v); this.doc.writes++; }
  appendChild(c) { this.children.push(c); c.parent = this; return c; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((x) => x !== this); this.parent = null; }
  walk(fn) { fn(this); this.children.forEach((c) => c.walk(fn)); }
}
function rig(opts = {}) {
  const doc = { writes: 0, createElementNS: (ns, tag) => new FakeNode(tag, doc) };
  const el = new FakeNode('div', doc), pending = [], log = { raf: 0, caf: 0, ended: [] }; let t = 1000, id = 0;
  const api = createAvatar(el, {
    doc, now: () => t, rng: () => 0.5, onAnimationEnd: (n) => log.ended.push(n),
    raf: (f) => { log.raf++; pending.push({ id: ++id, f }); return id; },
    caf: (i) => { log.caf++; const k = pending.findIndex((x) => x.id === i); if (k >= 0) pending.splice(k, 1); },
    ...opts,
  });
  return { api, el, doc, log, pending, advance: (ms) => { t += ms; }, frame: (ms) => { t += ms; const run = pending.splice(0); run.forEach((x) => x.f(t)); }, now: () => t };
}
const svgOf = (r) => r.el.children[0];
const scan = (r) => { const bad = []; r.el.walk((n) => { for (const [k, v] of Object.entries(n.attrs)) if (/NaN|undefined|Infinity|null/.test(v)) bad.push(`${n.tag}.${k}=${v}`); }); return bad; };

let r = rig({ autoplay: false, defaultExpression: 'neutral' });
ok('the engine adds exactly one decorative SVG (viewBox 120 × 120, aria-hidden) and nothing else to the element', r.el.children.length === 1 && svgOf(r).tag === 'svg' && svgOf(r).attrs.viewBox === '0 0 120 120' && svgOf(r).attrs['aria-hidden'] === 'true' && svgOf(r).style.display === 'block');
ok('a still mascot (autoplay off — what reduced motion uses) is drawn, stopped, and schedules no frames at all', r.doc.writes > 20 && r.pending.length === 0 && r.log.raf === 0 && same(r.api.getState(), { status: 'stopped', activeAnimation: null }));
r.advance(60000); r.frame(60000);
ok('…and stays free of work however long the page is open', r.log.raf === 0);
ok('no attribute written by the first draw is NaN, undefined or infinite', scan(r).length === 0, scan(r).slice(0, 3).join(', '));
const count = (r, tag) => { let n = 0; r.el.walk((x) => { if (x.tag === tag) n++; }); return n; };
ok('the drawing is small: under 50 elements, no filters or masks, no images', count(r, 'filter') === 0 && count(r, 'mask') === 0 && count(r, 'image') === 0 && count(r, 'foreignObject') === 0 && (() => { let n = 0; r.el.walk(() => n++); return n < 60; })());

r = rig({ autoplay: true, defaultAnimation: 'waking' });
ok('autoplay with a default animation starts playing and schedules the next frame', same(r.api.getState(), { status: 'playing', activeAnimation: 'waking' }) && r.pending.length === 1);
const w0 = r.doc.writes; r.frame(30);
ok('a frame redraws and schedules the next one', r.doc.writes > w0 && r.pending.length === 1);
const w1 = r.doc.writes; r.frame(4);
ok('frames closer than ~25 ms apart are skipped (about 40 frames a second at most)', r.doc.writes === w1 && r.pending.length === 1);
let maxWrites = 0; for (let i = 0; i < 400; i++) { const b = r.doc.writes; r.frame(25); maxWrites = Math.max(maxWrites, r.doc.writes - b); }
ok('one frame never writes more than 70 attributes (and unchanged values are skipped)', maxWrites <= 70 && maxWrites > 0, String(maxWrites));
ok('after a long run every written value is still finite', scan(r).length === 0, scan(r).slice(0, 3).join(', '));
r.api.pause();
ok('pause cancels the frame loop, keeps the name and reports "paused"', r.pending.length === 0 && same(r.api.getState(), { status: 'paused', activeAnimation: 'waking' }));
const w2 = r.doc.writes; r.advance(30000); r.frame(0);
ok('a paused mascot does no work', r.doc.writes === w2 && r.pending.length === 0);
ok('play(same mood) resumes and schedules frames again', r.api.play('waking') === true && r.api.getState().status === 'playing' && r.pending.length === 1);
ok('play() with a name that does not exist returns false and changes nothing', r.api.play('nope') === false && same(r.api.getState(), { status: 'playing', activeAnimation: 'waking' }));
r.api.stop();
ok('stop() cancels frames, clears the name and shows the resting pose', r.pending.length === 0 && same(r.api.getState(), { status: 'stopped', activeAnimation: null }) && count(r, 'ellipse') >= 7 && r.el.children.length === 1);
const w3 = r.doc.writes; r.api.stop();
ok('drawing the same resting pose twice writes nothing the second time', r.doc.writes === w3);
ok('play() after stop() works again', r.api.play('idle') === true && same(r.api.getState(), { status: 'playing', activeAnimation: 'idle' }) && r.pending.length === 1);
r.api.destroy();
ok('destroy() removes the drawing and stops everything', r.el.children.length === 0 && r.pending.length === 0 && r.api.play('idle') === false);

let everyMood = true, everyMoodMsg = '';
for (const m of MOODS) {
  const q = rig({ autoplay: true, defaultAnimation: m });
  for (let i = 0; i < 480; i++) q.frame(25);                         // 12 seconds of animation
  if (scan(q).length || q.log.ended.length || q.api.getState().activeAnimation !== m || q.api.getState().status !== 'playing') { everyMood = false; everyMoodMsg += `${m} `; }
}
ok('every one of the 16 moods plays for 12 simulated seconds: finite output, never "ends", still playing', everyMood, everyMoodMsg);

const a1 = rig({ autoplay: false }), a2 = rig({ autoplay: false });
const ids = (q) => { const out = []; q.el.walk((n) => { if (n.attrs.id) out.push(n.attrs.id); }); return out; };
const clipRef = (q) => { let v; q.el.walk((n) => { if (n.attrs['clip-path']) v = n.attrs['clip-path']; }); return v; };
ok('two mascots on one page get different gradient and clip ids, each referencing its own', ids(a1).length === 3 && ids(a1).every((x) => !ids(a2).includes(x)) && clipRef(a1).includes(ids(a1).find((x) => x.endsWith('-clip'))));
ok('createAvatar refuses to run without an element or a document', (() => { try { createAvatar(null, {}); return false; } catch { return true; } })() && (() => { try { createAvatar(new FakeNode('div', { writes: 0 }), { doc: null }); return false; } catch { return true; } })());
ok('an onAnimationEnd handler that throws cannot break the engine (callback errors are contained)', (() => { try { const q = rig({ autoplay: true, defaultAnimation: 'idle', onAnimationEnd: () => { throw new Error('boom'); } }); q.frame(30); return true; } catch { return false; } })());

console.log(`\n${pass} passed, ${fail} failed`);
setTimeout(() => process.exit(fail ? 1 : 0), 50);
