/**
 * HKDevLab's own mascot ("Hex"): poses and animations. ORIGINAL work written for this site — nothing here is translated from, or derived
 * from, any third-party avatar format, preset list or package.
 *
 * The character is a rounded-square head with a dark glass visor, a glowing antenna and two side pods. The face is drawn from plain numbers:
 * two eyes (size, gaze, upper and lower eyelid cover, eyelid tilt), a mouth (width, curve, opening) and a few extras (blush, glow, "zzz",
 * sparkles, thinking dots). A POSE is one full set of those numbers. An ANIMATION is a looping list of steps — "ease into this pose over
 * `blend` ms, then hold it for `hold` ms" — plus a blink schedule and a little ambient motion (float, sway, bounce, breathing).
 * Everything is plain data with no DOM, so it can be checked in Node (see server/test-mascot.mjs).
 */

export const PALETTE = {
  bodyA: '#2f6bff', bodyB: '#6a3dff', bodyC: '#a64dff',    // blue → violet → purple head
  pod: '#4b34d9', visor: '#0a1030', visorEdge: '#1de4ff',
  eyeA: '#f2ffff', eyeB: '#74efff', glow: '#1de4ff',
  mouth: '#eaffff', mouthIn: '#ff6fb5', blush: '#ff7ad9',
  zzz: '#cfe8ff', spark: '#fff2a8', dot: '#9fe8ff', shadow: '#050816',
};

/** Every number a pose carries, with the range the renderer is designed for (checked by the tests). */
export const RANGES = {
  tilt: [-12, 12], dx: [-6, 6], dy: [-8, 8], sy: [0.9, 1.1],      // whole head: lean (°), shift (px), squash
  gx: [-8, 8], gy: [-8, 8],                                       // where both eyes look (px)
  ew: [8, 18], eh: [8, 26], es: [10, 20], ey: [-4, 4], eL: [0.6, 1.4], eR: [0.6, 1.4],   // eye width, height, half-spacing, drop, left/right height factor
  uL: [0, 1], uR: [0, 1], lL: [0, 1], lR: [0, 1],                 // upper / lower eyelid cover per eye (1 = shut)
  tL: [-14, 14], tR: [-14, 14],                                   // upper-eyelid tilt per eye (+ = angry slope, − = worried slope), degrees
  mw: [3, 12], mc: [-5, 5.5], mo: [0, 5.5], my: [-3, 4],          // mouth half-width, curve (+ smile), opening, drop
  blush: [0, 1], ant: [-20, 20], glow: [0, 1], zzz: [0, 1], spark: [0, 1], dots: [0, 1],
};
export const FIELDS = Object.keys(RANGES);

const BASE = {
  tilt: 0, dx: 0, dy: 0, sy: 1, gx: 0, gy: 0, ew: 13, eh: 19, es: 15, ey: 0, eL: 1, eR: 1,
  uL: 0, uR: 0, lL: 0, lR: 0, tL: 0, tR: 0, mw: 7, mc: 2.5, mo: 0, my: 0,
  blush: 0, ant: 0, glow: 0.6, zzz: 0, spark: 0, dots: 0,
};
/** `u` and `l` are shorthand for "both eyes". */
const make = (o) => { const { u, l, ...rest } = o; const p = { ...BASE, ...rest }; if (u !== undefined) p.uL = p.uR = u; if (l !== undefined) p.lL = p.lR = l; return Object.freeze(p); };

export const POSES = Object.freeze({
  neutral: make({}),
  calm: make({ eh: 18, mc: 3, gy: 0.5, glow: 0.55 }),
  lookR: make({ eh: 18, gx: 5, gy: -1, tilt: 2 }),
  lookL: make({ eh: 18, gx: -5, gy: -1, tilt: -2 }),
  lookUp: make({ gx: -2, gy: -5, mc: 2, tilt: -3 }),

  sleepy: make({ u: 0.5, eh: 17, mc: 1, mw: 6, tilt: 3, dy: 1.5, ant: 8, glow: 0.35 }),
  sleepyDeep: make({ u: 0.82, eh: 16, mc: 0.5, mw: 5, tilt: 5, dy: 2.5, ant: 11, glow: 0.25 }),
  asleep: make({ u: 0.97, eh: 16, mc: 1.5, mw: 5, tilt: 5, dy: 3, sy: 0.97, ant: 14, glow: 0.12, zzz: 1 }),
  asleepB: make({ u: 0.97, eh: 16, mc: 1.2, mw: 5, mo: 1.2, tilt: 4, dy: 3.6, sy: 0.96, ant: 12, glow: 0.12, zzz: 1 }),
  wakeA: make({ u: 0.9, eh: 16, mc: 1, tilt: 3, dy: 2, ant: 10, glow: 0.25 }),
  wakeYawn: make({ u: 0.72, eh: 17, mw: 6, mc: -0.5, mo: 5.5, my: 1, dy: -1, tilt: -2, ant: -4, glow: 0.45 }),
  wakeWide: make({ ew: 14, eh: 22, mc: 2, mo: 1.5, dy: -1.5, ant: -8, glow: 0.9 }),

  joy: make({ l: 0.85, ew: 14, eh: 18, mc: 5, mw: 8, blush: 0.5, tilt: -2, dy: -1, glow: 0.8 }),
  joyB: make({ l: 0.85, ew: 14, eh: 18, mc: 5.5, mw: 8, blush: 0.6, tilt: 3, dy: -2.5, glow: 0.9 }),
  grin: make({ l: 0.95, u: 0.08, ew: 14, eh: 18, mc: 4, mo: 5.5, mw: 9, blush: 0.8, tilt: -5, dy: -3, glow: 0.9 }),
  grinB: make({ l: 0.95, u: 0.08, ew: 14, eh: 18, mc: 4, mo: 5.5, mw: 9, blush: 0.8, tilt: 5, dy: -3, glow: 0.9 }),
  wide: make({ ew: 15, eh: 23, mc: 5, mo: 4, mw: 8, blush: 0.3, dy: -2, ant: -10, glow: 1 }),
  wideB: make({ ew: 15, eh: 23, mc: 5, mo: 5, mw: 8.5, blush: 0.35, dy: -5, tilt: 3, ant: -14, glow: 1 }),
  proud: make({ u: 0.22, l: 0.5, mc: 5, mw: 8, tilt: -3, dy: -1, gy: -2, blush: 0.25, ant: -6, glow: 0.95 }),
  proudB: make({ u: 0.22, l: 0.5, mc: 5, mw: 8, tilt: 2, dy: -3.5, gy: -2, blush: 0.25, ant: -8, glow: 1 }),
  cheer: make({ l: 0.9, ew: 14, eh: 18, mc: 5.5, mo: 5.5, mw: 10, blush: 0.9, dy: -3, ant: -12, glow: 1, spark: 1 }),
  cheerB: make({ l: 0.9, ew: 14, eh: 18, mc: 5.5, mo: 5.5, mw: 10, blush: 0.9, dy: -6, tilt: 5, ant: -14, glow: 1, spark: 1 }),
  cheerC: make({ l: 0.9, ew: 14, eh: 18, mc: 5.5, mo: 5.5, mw: 10, blush: 0.9, dy: -6, tilt: -5, ant: -14, glow: 1, spark: 1 }),

  curious: make({ eL: 1.14, eR: 0.86, tL: -6, tR: 8, tilt: 6, gx: 3, gy: -1, mc: 1.5, mw: 6, glow: 0.8 }),
  curiousB: make({ eL: 0.9, eR: 1.12, tL: 8, tR: -6, tilt: -6, gx: -3, gy: -1, mc: 1.5, mw: 6, glow: 0.8 }),
  think: make({ gx: -5, gy: -5, tL: 5, tR: -3, mc: 0, mw: 5, my: 1, tilt: -4, dots: 1, glow: 0.7 }),
  thinkB: make({ gx: 5, gy: -4, tL: -3, tR: 5, mc: -0.5, mw: 5, my: 1, tilt: 4, dots: 1, glow: 0.7 }),
  listen: make({ ew: 14, eh: 22, mc: 2, mw: 6, tilt: 3, ant: 6, glow: 0.95 }),
  listenB: make({ ew: 14, eh: 22, mc: 2, mw: 6, tilt: -3, gx: 2, ant: -6, glow: 0.95 }),
  focus: make({ u: 0.25, tL: 6, tR: 6, ew: 15, eh: 15, gy: 1, mc: 0, mw: 6, glow: 1, dots: 1 }),
  focusB: make({ u: 0.25, tL: 6, tR: 6, ew: 15, eh: 15, gx: 3, gy: 1, mc: 0, mw: 6, glow: 1, dots: 1 }),
  focusC: make({ u: 0.25, tL: 6, tR: 6, ew: 15, eh: 15, gx: -3, gy: 1, mc: 0, mw: 6, glow: 1, dots: 1 }),
  shy: make({ u: 0.22, l: 0.3, gx: -6, gy: 4, mc: 3, mw: 5, blush: 1, tilt: -6, dy: 1.5, sy: 0.98, glow: 0.5 }),
  shyB: make({ u: 0.22, l: 0.3, gx: -2, gy: 5, mc: 2.5, mw: 5, blush: 1, tilt: -4, dy: 2, sy: 0.98, glow: 0.5 }),
  confused: make({ tL: -10, tR: 6, eL: 1.1, eR: 0.85, mc: -2.5, mw: 6, my: 1, tilt: 7, gx: 3, glow: 0.6 }),
  confusedB: make({ tL: -8, tR: 9, eL: 0.9, eR: 1.1, mc: -3, mw: 5, my: 1.5, tilt: -6, gx: -3, glow: 0.6 }),
  winkR: make({ uR: 0.96, lL: 0.6, mc: 5, mw: 8, tilt: 6, blush: 0.5, dy: -1, glow: 0.9 }),
  winkL: make({ uL: 0.96, lR: 0.6, mc: 5, mw: 8, tilt: -6, blush: 0.5, dy: -1, glow: 0.9 }),
});

const S = (pose, blend, hold) => ({ pose, blend, hold });
const loop = (steps, extra = {}) => Object.freeze({ mode: 'loop', steps: Object.freeze(steps), blink: null, motion: null, ...extra });
const SLOW = { min: 2400, max: 4600, dur: 150 }, LIVELY = { min: 1800, max: 3600, dur: 140 };

/**
 * One animation per mood the page can ask for (see BUTTONS / SECTIONS / wantMood in mascot.js). Every one loops: the page decides how long a
 * mood lasts and what comes next. The first step's `blend` is how long the mascot takes to ease from whatever it was doing.
 */
export const ANIMATIONS = Object.freeze({
  idle: loop([S('calm', 420, 2600), S('lookR', 520, 1200), S('calm', 480, 2200), S('lookL', 520, 1100), S('lookUp', 600, 900)],
    { blink: SLOW, motion: { float: { amp: 1.6, hz: 0.35 }, breathe: { amp: 0.012, hz: 0.35 }, sway: { deg: 0.8, hz: 0.22 } } }),
  waking: loop([S('wakeA', 120, 200), S('wakeYawn', 260, 480), S('wakeWide', 200, 260), S('calm', 300, 300)],
    { motion: { float: { amp: 1, hz: 0.5 } } }),
  sleeping: loop([S('asleep', 700, 2800), S('asleepB', 1400, 400)],
    { motion: { breathe: { amp: 0.02, hz: 0.22 }, sway: { deg: 0.6, hz: 0.12 } } }),
  drowsy: loop([S('sleepy', 600, 1800), S('sleepyDeep', 700, 700), S('sleepy', 500, 1400)],
    { blink: { min: 3000, max: 5000, dur: 260 }, motion: { sway: { deg: 1.2, hz: 0.18 }, breathe: { amp: 0.012, hz: 0.25 } } }),
  thinking: loop([S('think', 420, 1400), S('thinkB', 520, 1200), S('think', 520, 900)],
    { blink: { min: 2000, max: 3600, dur: 160 }, motion: { float: { amp: 1, hz: 0.4 } } }),
  listening: loop([S('listen', 360, 1800), S('listenB', 500, 1500)],
    { blink: SLOW, motion: { float: { amp: 1.2, hz: 0.5 } } }),
  working: loop([S('focus', 300, 700), S('focusB', 300, 600), S('focus', 300, 700), S('focusC', 300, 600)],
    { blink: { min: 3200, max: 5200, dur: 150 }, motion: { bounce: { amp: 0.8, hz: 2.2 } } }),
  happy: loop([S('joy', 300, 1500), S('joyB', 400, 700), S('joy', 400, 1400)],
    { motion: { float: { amp: 1.4, hz: 0.45 }, sway: { deg: 1.2, hz: 0.3 } } }),
  excited: loop([S('wide', 220, 500), S('wideB', 180, 260), S('wide', 220, 500), S('joyB', 200, 300)],
    { blink: LIVELY, motion: { bounce: { amp: 3.2, hz: 1.6 }, sway: { deg: 2, hz: 0.8 } } }),
  curious: loop([S('curious', 360, 1400), S('curiousB', 500, 1300)],
    { blink: LIVELY, motion: { float: { amp: 1.2, hz: 0.4 }, sway: { deg: 1, hz: 0.3 } } }),
  proud: loop([S('proud', 400, 1800), S('proudB', 500, 1000)],
    { blink: SLOW, motion: { float: { amp: 1.4, hz: 0.4 } } }),
  shy: loop([S('shy', 360, 1500), S('shyB', 500, 900), S('shy', 500, 1100)],
    { blink: LIVELY, motion: { sway: { deg: 1.6, hz: 0.35 } } }),
  playful: loop([S('winkR', 240, 700), S('joyB', 260, 500), S('winkL', 260, 700), S('joy', 260, 500)],
    { motion: { sway: { deg: 4, hz: 1.1 }, float: { amp: 1.2, hz: 0.9 } } }),
  confused: loop([S('confused', 260, 1100), S('confusedB', 260, 900)],
    { blink: LIVELY, motion: { sway: { deg: 2, hz: 0.9 } } }),
  laughing: loop([S('grin', 140, 260), S('grinB', 140, 260), S('grin', 140, 260), S('grinB', 140, 260)],
    { motion: { bounce: { amp: 2, hz: 3 } } }),
  celebrate: loop([S('cheer', 200, 600), S('cheerB', 200, 300), S('cheer', 200, 600), S('cheerC', 200, 300)],
    { motion: { bounce: { amp: 3.5, hz: 2 } } }),
});

export const MOODS = Object.freeze(Object.keys(ANIMATIONS));
