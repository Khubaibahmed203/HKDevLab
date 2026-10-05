// Takes a screenshot of every Selected Concept's REAL landing page and saves it where the website's card (and the admin) expect it:
//     public/assets/projects/<address>-preview.webp        (1440 × 900 desktop viewport, WebP)
//
//   npm run capture-project-previews                          the projects in content/default.json
//   npm run capture-project-previews -- --from https://www.hkdevlab.com     the projects published on a live site (managed in /admin)
//   npm run capture-project-previews -- --only portfolio      only projects whose name or address contains "portfolio"
//
// Each project's Live URL is opened in a headless Chrome / Edge (puppeteer-core — it uses the browser already installed, nothing is
// downloaded; set CHROME_PATH to use another). The page is given time to load fonts, images and videos and for its opening animation
// to settle, then the viewport is captured. A page that is unreachable, answers with an error, shows a bot-protection / sign-in wall
// or looks blank keeps its PREVIOUS screenshot and is reported — nothing fails silently, and nothing here tries to get past a wall.
// The browser window is never part of the picture. Exit code 1 when any project failed.
import puppeteer from 'puppeteer-core';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isWebUrl, previewPath } from '../content/schema.js';
import { isShown } from '../content/visibility.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULTS = join(root, 'content/default.json');
const PUBLIC = join(root, 'public');
const VIEW = { width: 1440, height: 900, deviceScaleFactor: 1 };
const QUALITY = 82;                       // WebP quality: a 1440 × 900 landing page comes out at roughly 40–120 KB
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const from = opt('--from'), only = opt('--only')?.toLowerCase();

/* ───────────── which projects ───────────── */
async function projects() {
  let content;
  if (from) {
    const res = await fetch(new URL('/api/content', from));
    if (!res.ok) throw new Error(`${from} answered ${res.status} for /api/content`);
    content = await res.json();
  } else content = JSON.parse(readFileSync(DEFAULTS, 'utf8'));
  return content.work.items.filter((w) => w.kind === 'live' && isShown(w)).filter((w) => !only || `${w.name} ${w.liveUrl}`.toLowerCase().includes(only));
}

/* ───────────── the browser ───────────── */
function findBrowser() {
  const env = process.env, found = (list) => list.filter(Boolean).find((p) => existsSync(p));
  const path = env.CHROME_PATH || env.PUPPETEER_EXECUTABLE_PATH || found([
    env.ProgramFiles && join(env.ProgramFiles, 'Google/Chrome/Application/chrome.exe'),
    env['ProgramFiles(x86)'] && join(env['ProgramFiles(x86)'], 'Google/Chrome/Application/chrome.exe'),
    env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
    env['ProgramFiles(x86)'] && join(env['ProgramFiles(x86)'], 'Microsoft/Edge/Application/msedge.exe'),
    env.ProgramFiles && join(env.ProgramFiles, 'Microsoft/Edge/Application/msedge.exe'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium',
  ]);
  if (!path || !existsSync(path)) throw new Error('No Chrome / Edge found. Install one, or set CHROME_PATH to its executable.');
  return path;
}

/* ───────────── one project ───────────── */
const WALL = /checking your browser|just a moment|verify you are human|are you a robot|captcha|enable javascript and cookies|authentication required|access denied|log in to vercel|deployment could not be found|vercel authentication/i;
const NET = { ERR_NAME_NOT_RESOLVED: 'domain name not found', ERR_CONNECTION_REFUSED: 'connection refused', ERR_CONNECTION_TIMED_OUT: 'connection timed out', ERR_CERT_COMMON_NAME_INVALID: 'invalid security certificate', ERR_CERT_AUTHORITY_INVALID: 'invalid security certificate', ERR_CERT_DATE_INVALID: 'expired security certificate', ERR_INTERNET_DISCONNECTED: 'no internet connection' };

/** Waits until fonts, images and videos are in, then until the picture stops changing (a hero animation or loader has finished). */
async function settle(page) {
  await page.evaluate(async () => {
    const once = (el, ...evs) => new Promise((r) => { evs.forEach((ev) => el.addEventListener(ev, r, { once: true })); setTimeout(r, 8000); });
    await document.fonts.ready;
    await Promise.all([...document.images].filter((i) => !i.complete).map((i) => once(i, 'load', 'error')));
    await Promise.all([...document.querySelectorAll('video')].filter((v) => v.readyState < 2 && v.preload !== 'none').map((v) => once(v, 'loadeddata', 'error')));
    scrollTo(0, 0);
  });
  await sleep(1500);
  let last = null, calm = 0;
  for (const t0 = Date.now(); Date.now() - t0 < 15000; await sleep(600)) {
    const size = (await page.screenshot({ type: 'jpeg', quality: 40 })).length;
    calm = last !== null && Math.abs(size - last) <= last * 0.01 ? calm + 1 : 0;       // the picture is (all but) unchanged
    last = size;
    if (calm >= 3) return 'settled';
  }
  return 'still animating after 15 s — captured anyway';
}

/** A page that is one flat colour (a blank page or a bare loading screen) is not a landing page. Looked at in the browser itself — no image library needed. */
async function looksBlank(browser, bytes) {
  const probe = await browser.newPage();
  try {
    return await probe.evaluate(async (b64) => {
      const bmp = await createImageBitmap(await (await fetch(`data:image/webp;base64,${b64}`)).blob());
      const c = new OffscreenCanvas(96, 60), g = c.getContext('2d');
      g.drawImage(bmp, 0, 0, 96, 60);
      const px = g.getImageData(0, 0, 96, 60).data, seen = new Set();
      for (let i = 0; i < px.length; i += 4) seen.add(((px[i] >> 4) << 8) | ((px[i + 1] >> 4) << 4) | (px[i + 2] >> 4));
      return seen.size < 6;
    }, Buffer.from(bytes).toString('base64'));
  } finally { await probe.close(); }
}

async function capture(browser, url) {
  const page = await browser.newPage();
  try {
    await page.setViewport(VIEW);
    let res;
    try { res = await page.goto(url, { waitUntil: 'load', timeout: 45000 }); }
    catch (e) {
      const code = /net::(\w+)/.exec(e.message)?.[1];
      throw new Error(`URL unavailable — ${NET[code] || code || (e.name === 'TimeoutError' ? 'timed out after 45 s' : e.message)}`);
    }
    if (res && res.status() >= 400) throw new Error(`URL unavailable — HTTP ${res.status()}`);
    await page.waitForNetworkIdle({ idleTime: 800, timeout: 12000 }).catch(() => {});      // a site that never goes quiet is captured anyway
    const heading = await page.evaluate(() => `${document.title} ${document.body?.innerText.slice(0, 300) || ''}`);
    if (WALL.test(heading)) throw new Error('an access / bot-protection page is in the way (not bypassed)');
    const note = await settle(page);
    const bytes = await page.screenshot({ type: 'webp', quality: QUALITY });             // the page only — never the browser window
    if (await looksBlank(browser, bytes)) throw new Error('the page looks blank (a loading screen?)');
    return { bytes, note };
  } finally { await page.close(); }
}

/** Keeps content/default.json's "preview" in step (one line per project there, so edit the line rather than rewrite the file). */
function recordPreview(url, path) {
  let text = readFileSync(DEFAULTS, 'utf8');
  const lines = text.split('\n'), i = lines.findIndex((l) => l.includes(`"liveUrl": "${url}"`));
  if (i < 0) return;
  lines[i] = /"preview": "[^"]*"/.test(lines[i]) ? lines[i].replace(/"preview": "[^"]*"/, `"preview": "${path}"`) : lines[i].replace(/\s*\}(,?)\s*$/, `, "preview": "${path}" }$1`);
  if (lines.join('\n') !== text) writeFileSync(DEFAULTS, lines.join('\n'));
}

/* ───────────── run ───────────── */
const items = await projects();
if (!items.length) { console.log('No live projects to capture.'); process.exit(0); }
const browser = await puppeteer.launch({ executablePath: findBrowser(), headless: true, args: ['--hide-scrollbars', '--mute-audio', '--autoplay-policy=no-user-gesture-required'] });
const failed = [];
console.log(`Capturing ${items.length} landing page${items.length > 1 ? 's' : ''} at ${VIEW.width} × ${VIEW.height}${from ? ` (projects of ${from})` : ''}\n`);
try {
  for (const w of items) {
    const label = w.name;
    try {
      if (!isWebUrl(w.liveUrl)) throw new Error('no valid Live URL is configured');
      const path = previewPath(w.liveUrl), file = join(PUBLIC, path);
      const { bytes, note } = await capture(browser, w.liveUrl);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(`${file}.tmp`, bytes); renameSync(`${file}.tmp`, file);               // the previous picture is only replaced by a good one
      if (!from) recordPreview(w.liveUrl, path);
      console.log(`✓ ${label} — ${w.liveUrl}\n    ${path.slice(1)}  (${(statSync(file).size / 1024).toFixed(0)} KB, ${note})`);
    } catch (e) {
      failed.push(label);
      const prev = isWebUrl(w.liveUrl) && existsSync(join(PUBLIC, previewPath(w.liveUrl)));
      console.log(`✗ ${label} — ${e.message}\n    ${w.liveUrl || '(no URL)'}  ${prev ? '(previous screenshot kept)' : '(no screenshot yet)'}`);
    }
  }
} finally { await browser.close(); }
console.log(`\n${items.length - failed.length} captured, ${failed.length} failed${failed.length ? `: ${failed.join(', ')}` : ''}`);
process.exit(failed.length ? 1 : 0);
