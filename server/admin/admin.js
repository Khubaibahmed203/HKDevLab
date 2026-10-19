import { SCHEMA, normalizeWebUrl, previewPath } from '/admin/schema.js';

/* HK DevLab admin portal — dependency-free. All user data is inserted with textContent / properties,
   never as HTML, and every state-changing request carries the X-Requested-With header the server requires. */
const $ = (s, r = document) => r.querySelector(s);
const app = $('#app');
let uid = 0;

function h(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n[k] = v;
    else if (k.includes('-') || k === 'for' || k === 'role') n.setAttribute(k, v === true ? '' : v);
    else n[k] = v;
  }
  kids.flat(Infinity).forEach((c) => c != null && c !== false && n.append(c));
  return n;
}
const clear = (el) => el.replaceChildren();
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');

async function api(method, path, body) {
  const headers = { 'X-Requested-With': 'hk-admin' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res, data = {};
  try {
    res = await fetch(path, { method, headers, credentials: 'same-origin', body: body !== undefined ? JSON.stringify(body) : undefined });
    data = await res.json().catch(() => ({}));
  } catch { return { ok: false, status: 0, data: { error: 'Could not reach the server.' } }; }
  if (res.status === 401 && !path.startsWith('/api/auth/')) { me = null; toast('Your session has ended — please sign in again.', true); showLogin(); }
  return { ok: res.ok, status: res.status, data };
}

function toast(msg, bad = false) {
  const t = h('div', { class: `toast${bad ? ' bad' : ''}`, text: msg });
  $('#toasts').append(t);
  setTimeout(() => t.remove(), bad ? 6000 : 3500);
}

/* ───────────── state ───────────── */
let me = null;
let googleOn = false;
let view = 'content';
let draft = null, saved = '', meta = {}, sectionKey = SCHEMA[0].key, errors = [];
const dirty = () => draft && JSON.stringify(draft) !== saved;
window.addEventListener('beforeunload', (e) => { if (dirty()) { e.preventDefault(); e.returnValue = ''; } });

/* ───────────── boot ───────────── */
const AUTH_ERRORS = {
  not_invited: "That Google account hasn't been added yet. Ask an admin to add your email under Users, then try again.",
  denied: 'Google sign-in was cancelled.',
  expired: 'That sign-in attempt expired, or was opened in a different browser. Please try again.',
  google_failed: 'Google sign-in did not complete. Please try again.',
  unverified_email: 'Google reports that email address as unverified, so it cannot be used.',
  account_mismatch: 'That email is already linked to a different Google account.',
  setup_key: 'Enter the setup key first, then choose the Google button.',
  too_many: 'Too many attempts. Please wait a few minutes.',
  google_off: 'Google sign-in is not set up on this server.',
};
async function boot() {
  const st = await api('GET', '/api/auth/status');
  googleOn = !!st.data.google;
  const authError = new URLSearchParams(location.search).get('auth_error');
  if (authError) history.replaceState(null, '', '/admin');
  if (st.data.setupRequired) { showSetup(st.data); if (authError) toast(AUTH_ERRORS[authError] || 'Sign-in failed.', true); return; }
  const r = await api('GET', '/api/auth/me');
  if (r.ok) { me = r.data.user; return showApp(); }
  showLogin();
  if (authError) toast(AUTH_ERRORS[authError] || 'Sign-in failed.', true);
}

/* ───────────── auth screens ───────────── */
function googleLogo() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 48 48'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('width', '18'); svg.setAttribute('height', '18');
  svg.innerHTML = '<path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>';
  return svg;
}

function authScreen({ title, lead, notice, fields, submit, onSubmit, google }) {
  const errEls = {};
  const inputs = {};
  const status = h('p', { class: 'err', role: 'alert' });
  const form = h('form', { class: 'auth__card', noValidate: true },
    h('img', { class: 'auth__logo', src: '/brand/mark.png', alt: '' }),
    h('h1', { text: title }),
    lead && h('p', { class: 'lead', text: lead }),
    ...(notice || []),
    ...fields.map((f) => {
      const id = `a${++uid}`;
      inputs[f.name] = h('input', { id, type: f.type || 'text', name: f.name, autocomplete: f.autocomplete || 'off', required: true });
      errEls[f.name] = h('small', { class: 'err' });
      return h('div', { class: 'fld' }, h('label', { for: id, text: f.label }), inputs[f.name], f.help && h('small', { class: 'help', text: f.help }), errEls[f.name]);
    }),
    h('button', { class: 'btn btn--primary', type: 'submit', text: submit }),
    google && h('div', { class: 'or' }, h('span', { text: 'or' })),
    google && h('button', { class: 'btn btn--google', type: 'button', onclick: async (e) => {
      const btn = e.currentTarget; btn.disabled = true; status.textContent = '';
      const r = await api('POST', '/api/auth/google/start', { token: inputs.token ? inputs.token.value : undefined });
      if (r.ok && r.data.url) { window.location.assign(r.data.url); return; }     // off to Google
      btn.disabled = false;
      const m = r.data.errors && r.data.errors.token;
      if (m && errEls.token) { errEls.token.textContent = m; inputs.token.focus(); } else status.textContent = r.data.error || 'Could not start Google sign-in.';
    } }, googleLogo(), google),
    status);
  form.onsubmit = async (e) => {
    e.preventDefault();
    Object.values(errEls).forEach((x) => (x.textContent = ''));
    status.textContent = '';
    const values = Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value]));
    const btn = $('button[type=submit]', form); btn.disabled = true;
    const out = await onSubmit(values);
    btn.disabled = false;
    if (out?.errors) { Object.entries(out.errors).forEach(([k, m]) => errEls[k] && (errEls[k].textContent = m)); inputs[Object.keys(out.errors)[0]]?.focus(); }
    if (out?.error) status.textContent = out.error;
  };
  clear(app);
  app.append(h('div', { class: 'auth' }, form));
  Object.values(inputs)[0]?.focus();
}

function showSetup(st) {
  authScreen({
    title: 'Create your admin account',
    lead: 'Welcome to HK DevLab. Set up the first account to start managing the site.',
    notice: [
      h('p', { class: 'notice', text: 'This first account becomes the administrator. Once it exists, setup closes for good — anyone else can only be added by an admin.' }),
      !st.setupTokenRequired && h('p', { class: 'notice notice--warn', text: 'Complete this right after you deploy. Until an account exists, the first person to open this page would become the admin.' }),
    ].filter(Boolean),
    fields: [
      { name: 'name', label: 'Your name', autocomplete: 'name' },
      { name: 'email', label: 'Email', type: 'email', autocomplete: 'email' },
      { name: 'password', label: 'Password', type: 'password', autocomplete: 'new-password', help: 'At least 10 characters.' },
      { name: 'confirm', label: 'Repeat password', type: 'password', autocomplete: 'new-password' },
      ...(st.setupTokenRequired ? [{ name: 'token', label: 'Setup key', help: 'The SETUP_TOKEN set on the server (needed for Google too).' }] : []),
    ],
    submit: 'Create admin account',
    google: googleOn ? 'Set up with Google' : null,
    onSubmit: async (v) => {
      if (v.password !== v.confirm) return { errors: { confirm: 'The passwords do not match.' } };
      const r = await api('POST', '/api/auth/setup', { name: v.name, email: v.email, password: v.password, token: v.token });
      if (!r.ok) return r.data.errors ? { errors: r.data.errors } : { error: r.data.error || 'Setup failed.' };
      me = r.data.user; showApp(); toast(`Welcome, ${me.name}. You are the admin.`);
    },
  });
}

function showLogin() {
  draft = null; saved = '';
  authScreen({
    title: 'Sign in', lead: 'HK DevLab admin portal',
    fields: [{ name: 'email', label: 'Email', type: 'email', autocomplete: 'username' }, { name: 'password', label: 'Password', type: 'password', autocomplete: 'current-password' }],
    submit: 'Sign in',
    google: googleOn ? 'Continue with Google' : null,
    onSubmit: async (v) => {
      const r = await api('POST', '/api/auth/login', v);
      if (!r.ok) return { error: r.data.error || 'Could not sign in.' };
      me = r.data.user; showApp();
    },
  });
}

/* ───────────── shell ───────────── */
function showApp() {
  clear(app);
  const nav = h('nav', { class: 'nav', 'aria-label': 'Sections' });
  const main = h('main', { id: 'main' });
  const tabs = [['content', 'Site content'], ['enquiries', 'Enquiries'], ['seo', 'SEO'], ...(me.role === 'admin' ? [['users', 'Users']] : []), ['account', 'Account']];
  const drawNav = (newCount) => {
    clear(nav);
    tabs.forEach(([key, label]) => {
      const b = h('button', { type: 'button', text: label, onclick: () => { view = key; drawNav(newCount); render(); } });
      if (key === view) b.setAttribute('aria-current', 'page');
      if (key === 'enquiries' && newCount) b.append(h('span', { class: 'badge', text: String(newCount), 'aria-label': `${newCount} new` }));
      nav.append(b);
    });
  };
  drawNav(0);
  api('GET', '/api/admin/enquiries?limit=1').then((r) => r.ok && drawNav(r.data.counts.new));
  app.append(
    h('header', { class: 'top' },
      h('div', { class: 'brand' }, h('img', { src: '/brand/mark.png', alt: '' }), h('span', {}, 'HK DevLab ', h('small', { text: 'ADMIN' }))),
      nav,
      h('div', { class: 'me' },
        h('span', { text: me.name }), h('span', { class: 'role', text: me.role }),
        h('a', { class: 'btn btn--sm', href: '/', target: '_blank', rel: 'noopener', text: 'View site ↗' }),
        h('button', { class: 'btn btn--sm', type: 'button', text: 'Sign out', onclick: async () => { if (dirty() && !confirm('You have unsaved changes. Sign out anyway?')) return; await api('POST', '/api/auth/logout'); me = null; showLogin(); } }))),
    main);
  render();
}
function render() {
  const main = $('#main'); clear(main);
  ({ content: renderContent, enquiries: renderEnquiries, seo: renderSeo, users: renderUsers, account: renderAccount })[view](main);
}

/* ───────────── content editor (built from the shared schema) ───────────── */
const applies = (f, obj) => !f.when || Object.entries(f.when).every(([k, v]) => v.includes(obj[k]));
const optVal = (o) => (typeof o === 'string' ? o : o.value);
const optLabel = (o) => (typeof o === 'string' ? o : o.label);
function blank(f) {
  switch (f.type) {
    case 'select': return optVal(f.options[0]);
    case 'color': return '#12a6ff';
    case 'bool': return f.default === true;
    case 'list': case 'numlist': case 'objlist': return [];
    case 'obj': return blankObj(f.fields);
    default: return '';
  }
}
const blankObj = (fields) => Object.fromEntries(fields.map((f) => [f.k, blank(f)]));
const ensure = (fields, obj) => fields.forEach((f) => { if (obj[f.k] === undefined) obj[f.k] = blank(f); });

const iconBtn = (glyph, label, onclick, disabled) => h('button', { class: 'icon-btn', type: 'button', text: glyph, 'aria-label': label, title: label, disabled, onclick: (e) => { e.preventDefault(); e.stopPropagation(); onclick(); } });
const wrapFld = (f, id, control) => h('div', { class: 'fld' }, h('label', { for: id, text: f.label }), control, f.help && h('small', { class: 'help', text: f.help }));

function group(fields, obj, touch) {
  ensure(fields, obj);
  const box = h('div', { class: 'grp' });
  const draw = () => box.replaceChildren(...fields.filter((f) => applies(f, obj)).map((f) => field(f, obj, touch, draw)));
  draw();
  return box;
}

function field(f, obj, touch, regroup) {
  const id = `f${++uid}`;
  switch (f.type) {
    case 'text': case 'href': {
      const i = h('input', { id, type: 'text', value: obj[f.k] ?? '', maxLength: f.max || 200, autocomplete: 'off', oninput: () => { obj[f.k] = i.value; touch(); } });
      return wrapFld(f, id, i);
    }
    case 'url': {                                   // same rule as the server (normalizeWebUrl); the server still has the last word
      const msg = h('small', { class: 'err' });
      const check = () => { const v = i.value.trim(); msg.textContent = v && !normalizeWebUrl(v) ? 'Enter a full web address, e.g. https://example.com/' : ''; };
      const i = h('input', {
        id, type: 'text', inputMode: 'url', placeholder: 'https://example-project.vercel.app/', value: obj[f.k] ?? '', maxLength: f.max || 300, autocomplete: 'off',
        oninput: () => { obj[f.k] = i.value; check(); touch(); pane && pane.changed(); },
        onchange: () => { const n = normalizeWebUrl(i.value); if (n && n !== i.value) { i.value = n; obj[f.k] = n; touch(); } check(); },   // "example.com" → "https://example.com/"
      });
      const pane = f.livePreview ? previewPane(() => normalizeWebUrl(i.value), () => obj.name) : null;
      check();
      return h('div', { class: 'fld' }, h('label', { for: id, text: f.label }), i, msg, pane && pane.el, f.help && h('small', { class: 'help', text: f.help }));
    }
    case 'area': case 'lines': {
      const count = h('div', { class: 'count' });
      const upd = () => (count.textContent = `${t.value.length} / ${f.max}`);
      const t = h('textarea', { id, value: obj[f.k] ?? '', maxLength: f.max, rows: f.type === 'lines' ? 2 : 3, oninput: () => { obj[f.k] = t.value; upd(); touch(); } });
      upd();
      return wrapFld(f, id, h('div', {}, t, count));
    }
    case 'select': {
      const s = h('select', { id, onchange: () => { obj[f.k] = s.value; touch(); regroup(); } }, f.options.map((o) => h('option', { value: optVal(o), text: optLabel(o), selected: optVal(o) === obj[f.k] })));
      return wrapFld(f, id, s);
    }
    case 'color': {
      const c = h('input', { id, type: 'color', value: /^#[0-9a-f]{6}$/i.test(obj[f.k]) ? obj[f.k] : '#12a6ff', oninput: () => { obj[f.k] = c.value; touch(); } });
      return wrapFld(f, id, c);
    }
    case 'bool': {
      const c = h('input', { id, type: 'checkbox', checked: !!obj[f.k], onchange: () => { obj[f.k] = c.checked; touch(); } });
      return h('div', { class: 'fld' }, h('label', { class: 'check', for: id }, c, f.label));
    }
    case 'numlist': {
      const i = h('input', { id, type: 'text', value: (obj[f.k] || []).join(', '), autocomplete: 'off', oninput: () => { obj[f.k] = i.value.split(/[,\s]+/).map(Number).filter((n) => i.value.trim() && Number.isFinite(n)); touch(); } });
      return wrapFld({ ...f, help: 'Separate with commas, e.g. 38, 54, 46, 68' }, id, i);
    }
    case 'image': return imageField(f, obj, touch);
    case 'list': return listField(f, obj, touch);
    case 'obj': return h('div', { class: 'fs' }, h('div', { class: 'lbl', text: f.label }), group(f.fields, obj[f.k], touch), f.help && h('small', { class: 'help', text: f.help }));
    case 'objlist': return objlistField(f, obj, touch);
    default: return h('div');
  }
}

/* ───────────── preview of a project's landing page, in a browser-style frame ───────────── */
// The Live URL is the only input. The picture is the screenshot that `npm run capture-project-previews` saved for that address
// (its file name is worked out from the address — previewPath in the schema), exactly what the website's card shows. No page is loaded,
// nothing is fetched from the project's site. Until the screenshot exists (a new or changed address) the pane says how to make it.
const hostPath = (u) => { try { const x = new URL(u); return x.host + (x.pathname === '/' && !x.search ? '' : x.pathname) + x.search; } catch { return ''; } };   // project.vercel.app/products
function lockIcon() {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('class', 'pv__lock'); svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(NS, 'path'); path.setAttribute('d', 'M7 10V8a5 5 0 0 1 10 0v2M6 10h12v10H6z'); svg.append(path);
  return svg;
}
function previewPane(getUrl, getName) {
  const addr = h('span', { class: 'pv__addr' });
  const open = h('a', { class: 'pv__open', target: '_blank', rel: 'noopener noreferrer', title: 'Open the live website in a new tab', 'aria-label': 'Open the live website in a new tab', text: '↗', hidden: true });
  const view = h('div', { class: 'pv__view' });
  const el = h('div', { class: 'pvw' }, h('div', { class: 'pv' }, h('div', { class: 'pv__bar' }, h('i'), h('i'), h('i'), h('span', { class: 'pv__pill' }, lockIcon(), addr), open), view));
  let seq = 0, timer = 0;

  const message = (title, text) => view.replaceChildren(h('div', { class: 'pv__msg' }, h('b', { text: title }), text && h('span', { text })));
  function run() {
    const url = getUrl(), src = url && previewPath(url), mine = ++seq;
    addr.textContent = url ? hostPath(url) : ''; open.hidden = !url; if (url) open.href = url;
    if (!src) return message('Landing-page preview', 'Enter the Live Website URL above and a screenshot of its landing page appears here.');
    const img = h('img', { alt: `${getName() || 'Project'} — landing page`, width: 1440, height: 900, decoding: 'async' });
    img.addEventListener('load', () => { if (mine === seq) view.replaceChildren(img); });
    img.addEventListener('error', () => { if (mine === seq) message('No screenshot of this page yet', 'Run "npm run capture-project-previews", commit the new picture in public/assets/projects/ and deploy — until then the card shows the project name.'); });
    img.src = src;
  }
  run();
  return { el, changed: () => { clearTimeout(timer); timer = setTimeout(run, 400); } };       // follows the address as it is typed
}

/* ───────────── photo field: choose → shrink in the browser → upload → preview ───────────── */
// Shrinking here keeps uploads small and quick, and re-drawing the picture drops hidden data such as GPS location from phone photos.
async function decodeImage(file) {
  if (window.createImageBitmap) { try { return await createImageBitmap(file); } catch { /* fall through */ } }
  const dataUrl = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => rej(new Error('read')); fr.readAsDataURL(file); });
  return new Promise((res, rej) => { const img = new Image(); img.onload = () => res(img); img.onerror = () => rej(new Error('decode')); img.src = dataUrl; });   // data: URL — the page's security policy allows those
}
const canvasBlob = (c, type, q) => new Promise((res) => c.toBlob(res, type, q));
async function shrinkPhoto(file) {
  const src = await decodeImage(file);
  try {
    for (const [max, q] of [[1400, 0.86], [1100, 0.8], [800, 0.74]]) {           // try smaller until it fits comfortably under the 1.5 MB limit
      const k = Math.min(1, max / Math.max(src.width, src.height));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(src.width * k)); c.height = Math.max(1, Math.round(src.height * k));
      c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
      let blob = await canvasBlob(c, 'image/webp', q);
      if (!blob || blob.type !== 'image/webp') blob = await canvasBlob(c, 'image/jpeg', q + 0.02);   // Safari cannot write WebP
      if (blob && blob.size <= 1_300_000) return blob;
    }
  } finally { if (src.close) src.close(); }
  throw new Error('too big');
}
async function uploadPhoto(blob) {
  try {
    const res = await fetch('/api/admin/media', { method: 'POST', headers: { 'X-Requested-With': 'hk-admin', 'Content-Type': blob.type }, credentials: 'same-origin', body: blob });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { me = null; toast('Your session has ended — please sign in again.', true); showLogin(); return { error: 'Please sign in again.' }; }
    return res.ok && data.url ? { url: data.url } : { error: data.error || 'The upload did not work. Please try again.' };
  } catch { return { error: 'Could not reach the server.' }; }
}
function imageField(f, obj, touch) {
  const noun = f.noun || 'photo';                    // "photo" for portraits, "screenshot" for project previews
  const thumb = h('div', { class: `photo__thumb${f.wide ? ' photo__thumb--wide' : ''}` });
  const msg = h('small', { class: 'help', role: 'status' });
  const input = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', hidden: true, 'aria-label': f.label });
  const pick = h('button', { class: 'btn btn--sm', type: 'button', onclick: () => input.click() });
  const drop = h('button', { class: 'btn btn--sm btn--danger', type: 'button', text: `Remove ${noun}`, onclick: () => { obj[f.k] = ''; touch(); msg.textContent = ''; draw(); } });
  const draw = () => {
    const has = !!obj[f.k];
    thumb.replaceChildren(has ? h('img', { src: obj[f.k], alt: `Current ${noun}` }) : h('span', { text: `No ${noun} yet` }));
    pick.textContent = has ? `Replace ${noun}` : `Upload ${noun}`;
    drop.hidden = !has;
  };
  const say = (text, bad) => { msg.className = bad ? 'err' : 'help'; msg.textContent = text; };
  input.onchange = async () => {
    const file = input.files && input.files[0]; input.value = '';
    if (!file) return;
    pick.disabled = true; say(`Preparing ${noun}…`);
    let blob;
    try { blob = await shrinkPhoto(file); } catch { pick.disabled = false; return say(`That file could not be read as a ${noun}. Please choose a JPG, PNG or WebP image.`, true); }
    say('Uploading…');
    const r = await uploadPhoto(blob);
    pick.disabled = false;
    if (r.error) return say(r.error, true);
    obj[f.k] = r.url; touch(); draw();
    say(`${noun[0].toUpperCase()}${noun.slice(1)} uploaded. Remember to click "Save changes" to put it on the site.`);
  };
  draw();
  return h('div', { class: 'fld' }, h('span', { class: 'lbl', text: f.label }),
    h('div', { class: 'photo' }, thumb, h('div', { class: 'photo__btns' }, pick, drop, input)), msg, f.help && h('small', { class: 'help', text: f.help }));
}

function listField(f, obj, touch) {
  const arr = obj[f.k];
  const box = h('div', { class: 'fs' });
  const move = (i, d) => { [arr[i], arr[i + d]] = [arr[i + d], arr[i]]; touch(); draw(); };
  const draw = (focusLast) => {
    const rows = arr.map((v, i) => {
      const inp = h('input', { type: 'text', value: v, maxLength: f.max || 80, 'aria-label': `${f.label} ${i + 1}`, oninput: () => { arr[i] = inp.value; touch(); } });
      return h('div', { class: 'row' }, inp,
        iconBtn('↑', 'Move up', () => move(i, -1), i === 0), iconBtn('↓', 'Move down', () => move(i, 1), i === arr.length - 1),
        iconBtn('✕', 'Remove', () => { arr.splice(i, 1); touch(); draw(); }, f.minItems && arr.length <= f.minItems));
    });
    box.replaceChildren(h('div', { class: 'lbl', text: f.label }), h('div', { class: 'rows' }, rows),
      h('div', {}, h('button', { class: 'btn btn--sm', type: 'button', text: '+ Add', disabled: f.maxItems && arr.length >= f.maxItems, onclick: () => { arr.push(''); touch(); draw(true); } })),
      f.maxItems && h('small', { class: 'help', text: `Up to ${f.maxItems}${f.minItems ? `, at least ${f.minItems}` : ''}.` }));
    if (focusLast) $$$('input', box).pop()?.focus();
  };
  draw();
  return box;
}
const $$$ = (s, r) => [...r.querySelectorAll(s)];

/** A confirmation in the portal's own modal (the safe answer is focused, so a stray Enter cancels). Resolves true / false. */
function confirmDialog({ title, body, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    const before = document.activeElement;
    const modal = h('div', { class: 'modal', role: 'alertdialog', 'aria-modal': 'true', 'aria-label': title });
    const done = (yes) => { modal.remove(); if (before && before.isConnected) before.focus(); resolve(yes); };
    modal.onclick = (e) => e.target === modal && done(false);
    modal.addEventListener('keydown', (e) => e.key === 'Escape' && done(false));
    const cancel = h('button', { class: 'btn', type: 'button', text: 'Cancel', onclick: () => done(false) });
    modal.append(h('div', {}, h('h2', { text: title }), h('p', { class: 'meta', text: body }),
      h('div', { class: 'row' }, cancel, h('button', { class: `btn ${danger ? 'btn--danger' : 'btn--primary'}`, type: 'button', text: confirmLabel, onclick: () => done(true) }))));
    document.body.append(modal);
    cancel.focus();
  });
}

/** Where a project stands, when its fields include the Featured / Published flags: [label, style, tooltip] or null. */
const statusOf = (item) => ('published' in item || 'featured' in item)
  ? (item.published === false ? ['Draft', 'bad', 'A draft — not shown on the website'] : item.featured === false ? ['Not featured', '', 'Published, but not shown in Selected Concepts'] : ['Live', 'ok', 'Shown on the website once saved'])
  : null;

const openState = new WeakMap();
function objlistField(f, obj, touch) {
  const arr = obj[f.k];
  const compact = f.fields.length <= 2;
  const box = h('div', { class: 'fs' });
  const move = (i, d) => { [arr[i], arr[i + d]] = [arr[i + d], arr[i]]; touch(); draw(); };
  const titleOf = (item, i) => (f.itemLabel && String(item[f.itemLabel] || '').trim()) || `Item ${i + 1}`;
  const remove = async (i) => {                     // a project, service, founder… is never deleted on a single click: ask first (tiny one-line rows go straight away)
    const yes = compact || await confirmDialog({
      title: `Delete “${titleOf(arr[i], i)}”?`,
      body: 'It is removed from this list now and from the website when you click “Save changes”. Nothing is lost until you save, and History can bring an older version back.',
      confirmLabel: 'Delete', danger: true,
    });
    if (yes) { arr.splice(i, 1); touch(); draw(); }
  };

  const draw = () => {
    const items = arr.map((item, i) => {
      ensure(f.fields, item);
      const controls = [
        iconBtn('↑', 'Move up', () => move(i, -1), i === 0), iconBtn('↓', 'Move down', () => move(i, 1), i === arr.length - 1),
        iconBtn('✕', 'Remove', () => remove(i), f.minItems && arr.length <= f.minItems),
      ];
      if (compact) return h('div', { class: 'row--compact' }, group(f.fields, item, touch), h('div', { class: 'row' }, controls));
      const ttl = h('span', { class: 'ttl', text: titleOf(item, i) });
      const pill = h('span', { class: 'pill' });
      const paint = () => { const s = statusOf(item); pill.hidden = !s; if (s) { pill.className = `pill ${s[1]}`.trim(); pill.textContent = s[0]; pill.title = s[2]; } };
      paint();
      const liveTouch = () => { ttl.textContent = titleOf(item, i); paint(); touch(); };
      const d = h('details', { class: 'item' },
        h('summary', {}, h('span', { class: 'num', text: String(i + 1).padStart(2, '0') }), ttl, pill, ...controls),
        h('div', { class: 'body' }, group(f.fields, item, liveTouch)));
      d.open = openState.has(item) ? openState.get(item) : arr.length <= 5;
      d.ontoggle = () => openState.set(item, d.open);
      return d;
    });
    box.replaceChildren(h('div', { class: 'lbl', text: f.label }), h('div', { class: 'rows' }, items),
      h('div', {}, h('button', { class: 'btn btn--sm', type: 'button', text: '+ Add', disabled: f.maxItems && arr.length >= f.maxItems, onclick: () => { const n = blankObj(f.fields); arr.push(n); openState.set(n, true); touch(); draw(); } })),
      f.maxItems && h('small', { class: 'help', text: `Up to ${f.maxItems}${f.minItems ? `, at least ${f.minItems}` : ''}.` }));
  };
  draw();
  return box;
}

async function renderContent(main) {
  if (!draft) {
    main.append(h('p', { class: 'boot', text: 'Loading content…' }));
    const r = await api('GET', '/api/admin/content');
    if (!r.ok) { clear(main); return main.append(h('p', { class: 'empty', text: r.data.error || 'Could not load the content.' })); }
    draft = r.data.content; saved = JSON.stringify(draft); meta = { updatedAt: r.data.updatedAt, updatedBy: r.data.updatedBy, version: r.data.version };
    clear(main);
  }
  const state = h('span', { class: 'state' });
  const saveBtn = h('button', { class: 'btn btn--primary', type: 'button', text: 'Save changes', onclick: save });
  const discardBtn = h('button', { class: 'btn', type: 'button', text: 'Discard changes', onclick: () => { if (confirm('Throw away your unsaved changes?')) { draft = JSON.parse(saved); errors = []; render(); } } });
  const updateBar = () => {
    const d = dirty();
    saveBtn.disabled = !d; discardBtn.disabled = !d;
    state.className = `state${d ? ' dirty' : ''}`;
    state.textContent = d ? 'You have unsaved changes' : meta.updatedAt ? `Live on the site · last saved ${fmtDate(meta.updatedAt)}${meta.updatedBy ? ` by ${meta.updatedBy}` : ''}` : 'Live on the site';
  };
  const touch = () => updateBar();

  async function save() {
    saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
    // the version says which copy of the content this draft was made from; the server refuses (409) a save from an out-of-date copy
    const r = await api('PUT', '/api/admin/content', { content: draft, version: meta.version });
    if (r.ok) {
      draft = r.data.content; saved = JSON.stringify(draft); meta = { updatedAt: r.data.updatedAt, updatedBy: r.data.updatedBy, version: r.data.version }; errors = [];
      toast('Saved — the change is live on the site now.');
    } else if (r.data.errors) { errors = r.data.errors; toast('Some fields need attention — see the list below.', true); }
    else toast(r.data.error || (r.status === 409 ? 'The content changed after you opened it, so nothing was saved. Reload this page, then make your changes again.' : 'Could not save.'), true);
    render();
  }

  const sec = SCHEMA.find((s) => s.key === sectionKey) || SCHEMA[0];
  const errSections = new Set(errors.map((e) => e.path.split(/[.[]/)[0]));
  const side = h('div', { class: 'side', role: 'tablist', 'aria-label': 'Site sections' },
    SCHEMA.map((s) => h('button', { type: 'button', text: s.label, 'aria-current': s.key === sectionKey ? 'true' : null, class: errSections.has(s.key) ? 'has-error' : '', onclick: () => { sectionKey = s.key; render(); window.scrollTo({ top: 0 }); } })));

  const errBox = errors.length && h('div', { class: 'errbox', role: 'alert' }, h('b', { text: `Please fix ${errors.length} thing${errors.length > 1 ? 's' : ''} before saving:` }),
    h('ul', {}, errors.map((e) => h('li', {}, e.message, ' ', e.path && h('button', { type: 'button', text: `(${e.path})`, onclick: () => { sectionKey = e.path.split(/[.[]/)[0]; render(); } })))));

  main.append(
    h('h1', { class: 'page-title' }, 'Site content', h('small', { text: 'Everything visitors read on the website. Changes go live the moment you save.' })),
    h('div', { class: 'ed' }, side,
      h('div', {}, errBox || null,
        h('section', { class: 'panel' }, h('h2', { text: sec.label }), sec.hint && h('p', { class: 'hint', text: sec.hint }), group(sec.fields, draft[sec.key], touch)),
        h('div', { class: 'savebar' }, state,
          h('button', { class: 'btn', type: 'button', text: 'History', onclick: showHistory }), discardBtn, saveBtn))));
  updateBar();
}

async function showHistory() {
  const r = await api('GET', '/api/admin/content/versions');
  const modal = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Version history' });
  const close = () => modal.remove();
  modal.onclick = (e) => e.target === modal && close();
  modal.addEventListener('keydown', (e) => e.key === 'Escape' && close());
  const list = r.ok && r.data.versions.length
    ? h('ul', { class: 'ulist' }, r.data.versions.map((v, i) => h('li', {},
        h('div', { class: 'who' }, h('b', { text: fmtDate(v.created_at) }), h('span', { text: `${v.user_email || 'system'}${v.note ? ` · ${v.note}` : ''}${i === 0 ? ' · current' : ''}` })),
        i > 0 && h('button', { class: 'btn btn--sm', type: 'button', text: 'Restore', onclick: async () => {
          if (!confirm(`Restore the version from ${fmtDate(v.created_at)}? It becomes the live site right away${dirty() ? ' and your unsaved changes will be lost' : ''}.`)) return;
          const res = await api('POST', `/api/admin/content/restore/${v.id}`);
          if (res.ok) { draft = res.data.content; saved = JSON.stringify(draft); meta = { updatedAt: res.data.updatedAt, updatedBy: res.data.updatedBy, version: res.data.version }; errors = []; close(); render(); toast('Version restored and live.'); }
          else toast(res.data.error || 'Could not restore that version.', true);
        } }))))
    : h('p', { class: 'empty', text: 'No history yet.' });
  modal.append(h('div', {}, h('h2', { text: 'Version history' }), h('p', { class: 'meta', text: 'Every save is kept (the latest 40). Restoring makes an old version live and keeps the rest of the history.' }), list,
    h('button', { class: 'btn', type: 'button', text: 'Close', onclick: close })));
  document.body.append(modal);
  modal.querySelector('button')?.focus();
}

/* ───────────── enquiries ───────────── */
let enqFilter = '';
async function renderEnquiries(main) {
  const list = h('div', {});
  const tabs = h('div', { class: 'tabs', role: 'group', 'aria-label': 'Filter by status' });
  main.append(h('h1', { class: 'page-title' }, 'Enquiries', h('small', { text: 'Messages sent through the contact form.' })), tabs, list,
    h('p', {}, h('a', { class: 'btn btn--sm', href: '/api/admin/export.csv', text: 'Export all as CSV' })));

  async function load() {
    const r = await api('GET', `/api/admin/enquiries${enqFilter ? `?status=${enqFilter}` : ''}`);
    if (!r.ok) return list.replaceChildren(h('p', { class: 'empty', text: 'Could not load enquiries — try refreshing.' }));
    const { items, counts } = r.data;
    tabs.replaceChildren(...[['', 'All', counts.total], ...['new', 'read', 'replied', 'spam'].map((s) => [s, s[0].toUpperCase() + s.slice(1), counts[s]])].map(([key, label, n]) =>
      h('button', { class: 'tab', type: 'button', 'aria-pressed': String(enqFilter === key), onclick: () => { enqFilter = key; load(); } }, label, h('b', { text: String(n) }))));
    list.replaceChildren(...(items.length ? items.map((it) => enquiryCard(it, load)) : [h('p', { class: 'empty', text: 'No enquiries here yet.' })]));
  }
  load();
}
function enquiryCard(item, reload) {
  const sel = h('select', { 'aria-label': `Status for enquiry ${item.id}`, onchange: async () => { await api('PATCH', `/api/admin/enquiries/${item.id}`, { status: sel.value }); reload(); } },
    ['new', 'read', 'replied', 'spam'].map((s) => h('option', { value: s, text: s, selected: s === item.status })));
  sel.style.width = 'auto';
  return h('article', { class: `card${item.status === 'new' ? ' is-new' : ''}` },
    h('div', { class: 'head' }, h('div', {}, h('b', { text: item.name }), ' ', h('a', { href: `mailto:${item.email}`, text: item.email })), h('div', { class: 'meta', text: `#${item.id} · ${fmtDate(item.created_at)} · ${item.service}` })),
    h('p', { class: 'msg', text: item.message }),
    h('div', { class: 'row' }, sel,
      h('a', { class: 'btn btn--sm', href: `mailto:${item.email}?subject=${encodeURIComponent('Re: your HK DevLab enquiry')}`, text: 'Reply by email' }),
      h('button', { class: 'btn btn--sm btn--danger', type: 'button', text: 'Delete', onclick: async () => { if (confirm(`Permanently delete enquiry #${item.id} from ${item.name}?`)) { await api('DELETE', `/api/admin/enquiries/${item.id}`); reload(); } } }),
      h('span', { class: `pill ${item.email_sent ? 'ok' : 'bad'}`, text: item.email_sent ? 'notified' : 'email not sent' })));
}

/* ───────────── SEO ─────────────
   A real crawler (server/seo/crawler.js) feeds a deterministic analyzer, whose findings can each get an
   optional AI-drafted recommendation — reviewed and approved/rejected by a person here, and only ever
   applied to production content after that explicit approval. Nothing here writes to the site on its own. */
let seoView = 'overview', seoSeverity = '', seoStatus = '', seoTypeFilter = '';
const SEO_SEVERITIES = ['critical', 'warning', 'info'];
const SEO_ISSUE_STATUSES = ['open', 'acknowledged', 'dismissed', 'resolved'];
const seoFmt = (n) => (n == null ? '—' : String(n));

async function renderSeo(main) {
  const tabs = h('div', { class: 'tabs', role: 'group', 'aria-label': 'SEO sections' });
  const body = h('div', {});
  main.append(h('h1', { class: 'page-title' }, 'SEO', h('small', { text: 'Crawl, analyze and (optionally) draft AI fixes for the public site — nothing changes live until you approve it.' })), tabs, body);

  const SECTIONS = [['overview', 'Overview'], ['issues', 'Issues'], ['recommendations', 'Recommendations'], ['history', 'History']];
  function drawTabs() {
    tabs.replaceChildren(...SECTIONS.map(([key, label]) => h('button', { class: 'tab', type: 'button', 'aria-pressed': String(seoView === key), onclick: () => { seoView = key; drawTabs(); renderBody(); } }, label)));
  }
  function renderBody() {
    clear(body);
    ({ overview: seoOverview, issues: seoIssuesView, recommendations: seoRecommendationsView, history: seoHistoryView })[seoView](body);
  }
  drawTabs();
  renderBody();
}

/** POST /scan only queues the job now (async — server/seo/jobs.js); this polls GET /scans/:id until it
 *  leaves 'queued'/'running', up to a few minutes, and toasts the final result. */
async function pollScan(auditId, runBtn) {
  for (let i = 0; i < 150; i++) {
    const r = await api('GET', `/api/admin/seo/scans/${auditId}`);
    if (!r.ok) return toast('Could not check the scan status.', true);
    const a = r.data.audit;
    if (a.status === 'complete') {
      const cmp = a.comparison;
      return toast(`Audit complete — score ${a.score}/100, ${a.issueCount} issue(s) across ${seoFmt(a.pages_crawled)} page(s)${cmp ? ` · ${cmp.resolvedCount} resolved, ${cmp.introducedCount} new since the last scan` : ''}.`);
    }
    if (a.status === 'failed') return toast(`Audit failed — ${a.summary || 'unknown error'}.`, true);
    if (runBtn) runBtn.textContent = a.status === 'queued' ? 'Queued…' : 'Crawling…';
    await new Promise((r2) => setTimeout(r2, 2000));
  }
  toast('The audit is taking longer than expected — check back on this tab shortly.', true);
}

/* ── Overview: latest scan, score, crawl stats, issue counts by severity ── */
async function seoOverview(main) {
  main.append(h('p', { class: 'boot', text: 'Loading…' }));
  const [latestR, issuesR] = await Promise.all([api('GET', '/api/admin/seo/scans/latest'), api('GET', '/api/admin/seo/issues?limit=1')]);
  clear(main);
  const audit = latestR.ok ? latestR.data.audit : null;
  const counts = issuesR.ok ? issuesR.data.counts : { total: 0, critical: 0, warning: 0, info: 0 };

  const runBtn = h('button', { class: 'btn btn--primary', type: 'button', text: 'Run SEO audit' });
  runBtn.onclick = async () => {
    runBtn.disabled = true; runBtn.textContent = 'Queuing…';
    const r = await api('POST', '/api/admin/seo/scan');
    if (!r.ok) { runBtn.disabled = false; runBtn.textContent = 'Run SEO audit'; return toast(r.status === 409 ? 'A scan is already queued or running for this website.' : (r.data.error || 'Could not start the audit.'), true); }
    runBtn.textContent = 'Crawling…';
    await pollScan(r.data.audit.id, runBtn);
    runBtn.disabled = false; runBtn.textContent = 'Run SEO audit';
    seoOverview(main);
  };

  const scoreText = !audit ? 'No audit has been run yet.' : audit.status === 'queued' ? 'Queued…' : audit.status === 'running' ? 'Running…' : audit.status === 'failed' ? `Failed — ${audit.summary || ''}` : `Score: ${audit.score}/100`;
  main.append(
    h('div', { class: 'panel' },
      h('h2', { text: scoreText }),
      audit && h('p', { class: 'meta' },
        `${audit.status} · ${audit.base_url || ''} · started ${fmtDate(audit.started_at)}`,
        audit.finished_at ? ` · finished ${fmtDate(audit.finished_at)}` : '',
        audit.duration_ms != null ? ` · ${(audit.duration_ms / 1000).toFixed(1)}s` : ''),
      h('div', { class: 'row' }, runBtn)));

  // a second `main.append()` call, not a second argument to the one above — a bare `audit && h(...)` handed
  // straight to the native DOM append() stringifies a falsy non-null/undefined-safe value as literal text
  // ("undefined") instead of being skipped, unlike a kid passed through this file's own h() helper
  if (audit) {
    main.append(h('div', { class: 'two' },
      h('div', { class: 'panel' }, h('h2', { text: 'Crawl' }),
        h('p', {}, h('b', { text: 'Pages crawled: ' }), seoFmt(audit.pages_crawled), audit.pages_planned ? ` (limit ${audit.pages_planned})` : ''),
        h('p', {}, h('b', { text: 'Errors: ' }), seoFmt(audit.errors_count)),
        h('p', {}, h('b', { text: 'Performance: ' }), audit.pagespeed?.available ? `${audit.pagespeed.performanceScore}/100 (PageSpeed, mobile)` : `unavailable${audit.pagespeed?.reason ? ` (${audit.pagespeed.reason})` : ''}`)),
      h('div', { class: 'panel' }, h('h2', { text: 'Issues' }),
        h('p', {}, h('span', { class: 'pill critical', text: `${counts.critical} critical` }), ' ', h('span', { class: 'pill warning', text: `${counts.warning} warning` }), ' ', h('span', { class: 'pill info', text: `${counts.info} info` })),
        h('p', { class: 'meta', text: `${counts.total} total` }))));
    main.append(seoDiagnosticsPanel(audit.specialist_diagnostics));
  }
}

/** Read-only view of seo_audits.specialist_diagnostics (already persisted + API-exposed). null = an audit that
 *  predates it; anything unexpected in the stored shape is skipped rather than allowed to break the Overview. */
function seoDiagnosticsPanel(d) {
  const panel = (...kids) => h('div', { class: 'panel' }, h('h2', { text: 'Specialist diagnostics' }), ...kids);
  if (d == null) return panel(h('p', { class: 'meta', text: 'No diagnostics recorded for this audit.' }));
  if (typeof d !== 'object' || Array.isArray(d)) return panel(h('p', { class: 'meta', text: 'Diagnostics for this audit are in an unexpected format.' }));

  const entries = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : []);
  const str = (v) => (v == null ? '' : String(v));
  const conflicts = entries(d.conflicts), skipped = entries(d.skipped), errors = entries(d.errors);
  if (!conflicts.length && !skipped.length && !errors.length) return panel(h('p', { class: 'meta', text: 'No conflicts, skipped findings or errors recorded.' }));

  const section = (title, ...kids) => h('details', { class: 'item' }, h('summary', {}, h('span', { class: 'ttl', text: title })), h('div', { class: 'body' }, ...kids));
  const pill = (label, n, cls) => h('span', { class: `pill ${n ? cls : ''}`, text: `${label}: ${n}` });

  const byReason = new Map();
  for (const s of skipped) { const r = str(s.reason) || 'unknown'; byReason.set(r, (byReason.get(r) || 0) + 1); }

  return panel(
    h('p', {}, pill('Conflicts', conflicts.length, 'warning'), ' ', pill('Skipped', skipped.length, 'info'), ' ', pill('Errors', errors.length, 'bad')),
    conflicts.length ? section(`Conflicts (${conflicts.length})`, conflicts.map((c) => h('div', {},
      h('p', { class: 'meta', text: `Issue #${str(c.issueId) || '—'} · ${(Array.isArray(c.agentNames) ? c.agentNames : []).map(str).join(', ')}` }),
      entries(c.proposals).map((p) => h('p', { class: 'msg', text: `${str(p.agentName)}: ${str(p.proposedType)} → ${str(p.proposedValue)}` }))))) : null,
    skipped.length ? section(`Skipped (${skipped.length})`, [...byReason].sort((a, b) => b[1] - a[1]).map(([reason, n]) => h('p', { class: 'meta', text: `${reason}: ${n}` }))) : null,
    errors.length ? section(`Errors (${errors.length})`, errors.map((e) => h('p', { class: 'msg', text: `${str(e.agentName)}: ${str(e.error)}` }))) : null);
}

/* ── Issues: filterable list, each with an optional "get AI recommendation" action ── */
async function seoIssuesView(main) {
  const sevTabs = h('div', { class: 'tabs', role: 'group', 'aria-label': 'Filter by severity' });
  const statusSel = h('select', { 'aria-label': 'Filter by status' }, h('option', { value: '', text: 'All statuses' }), SEO_ISSUE_STATUSES.map((s) => h('option', { value: s, text: s })));
  const typeInput = h('input', { type: 'text', placeholder: 'Filter by issue type…', 'aria-label': 'Filter by issue type', value: seoTypeFilter });
  const list = h('div', {});
  main.append(sevTabs, h('div', { class: 'row' }, statusSel, typeInput), list);

  function drawSevTabs() {
    sevTabs.replaceChildren(...[['', 'All'], ...SEO_SEVERITIES.map((s) => [s, s[0].toUpperCase() + s.slice(1)])].map(([key, label]) =>
      h('button', { class: 'tab', type: 'button', 'aria-pressed': String(seoSeverity === key), onclick: () => { seoSeverity = key; load(); } }, label)));
  }
  async function load() {
    drawSevTabs();
    const qs = new URLSearchParams();
    if (seoSeverity) qs.set('severity', seoSeverity);
    if (seoStatus) qs.set('status', seoStatus);
    if (seoTypeFilter) qs.set('type', seoTypeFilter);
    const r = await api('GET', `/api/admin/seo/issues?${qs}`);
    if (!r.ok) return list.replaceChildren(h('p', { class: 'empty', text: 'Could not load issues.' }));
    list.replaceChildren(...(r.data.issues.length ? r.data.issues.map(seoIssueCard) : [h('p', { class: 'empty', text: 'No issues match this filter.' })]));
  }
  statusSel.onchange = () => { seoStatus = statusSel.value; load(); };
  let typeTimer;
  typeInput.oninput = () => { seoTypeFilter = typeInput.value.trim(); clearTimeout(typeTimer); typeTimer = setTimeout(load, 300); };
  load();
}

function seoIssueCard(item) {
  const recBtn = h('button', { class: 'btn btn--sm', type: 'button', text: 'Get AI recommendation' });
  recBtn.onclick = async () => {
    recBtn.disabled = true; recBtn.textContent = 'Thinking…';
    const r = await api('POST', `/api/admin/seo/issues/${item.id}/recommend`);
    recBtn.disabled = false; recBtn.textContent = 'Get AI recommendation';
    if (!r.ok) return toast(r.status === 503 ? 'AI recommendations are not configured (set ANTHROPIC_API_KEY).' : (r.data.error || 'Could not generate a recommendation.'), true);
    toast('Recommendation drafted — see the Recommendations tab to review it.');
    recBtn.replaceWith(h('span', { class: 'meta', text: 'Recommendation drafted ✓' }));
  };
  return h('article', { class: 'card' },
    h('div', { class: 'head' }, h('b', { text: item.type }), h('span', { class: `pill ${item.severity}`, text: item.severity }), h('span', { class: 'meta', text: item.status })),
    h('p', { class: 'msg', text: item.detail }),
    item.recommendation ? h('p', { class: 'meta', text: item.recommendation }) : null,
    h('div', { class: 'row' }, recBtn));
}

/* ── Recommendations: AI-drafted fixes, each behind an approve/reject/apply gate ── */
async function seoRecommendationsView(main) {
  main.append(h('p', { class: 'boot', text: 'Loading…' }));
  const r = await api('GET', '/api/admin/seo/recommendations');
  clear(main);
  if (!r.ok) return main.append(h('p', { class: 'empty', text: 'Could not load recommendations.' }));
  main.append(...(r.data.recommendations.length ? r.data.recommendations.map((rec) => seoRecommendationCard(rec, () => seoRecommendationsView(main))) : [h('p', { class: 'empty', text: 'No recommendations yet — request one from an issue on the Issues tab.' })]));
}
/** Phase 3 Step 2: a small read-only badge showing whether the NEXT scan after this recommendation was
 *  applied found its originating issue still there. Only shown once a recommendation is 'applied' — nothing
 *  to verify before then. Reuses the existing pill/meta styles, no new CSS. */
function seoVerificationBadge(rec) {
  if (rec.status !== 'applied') return null;
  if (!rec.verified_status) return h('span', { class: 'meta', text: 'Not verified' });
  const BY_STATUS = { resolved: ['Verified fixed', 'ok'], 'still-present': ['Still present', 'warning'], unknown: ['Unable to verify', 'info'] };
  const [label, cls] = BY_STATUS[rec.verified_status] || ['Unable to verify', 'info'];
  return h('span', { class: `pill ${cls}`, text: label });
}

function seoRecommendationCard(rec, reload) {
  const approveBtn = h('button', { class: 'btn btn--sm btn--primary', type: 'button', text: 'Approve' });
  const rejectBtn = h('button', { class: 'btn btn--sm', type: 'button', text: 'Reject' });
  const applyBtn = h('button', { class: 'btn btn--sm btn--primary', type: 'button', text: 'Apply' });
  approveBtn.onclick = async () => { const x = await api('POST', `/api/admin/seo/recommendations/${rec.id}/approve`); if (!x.ok) return toast(x.data.error, true); toast('Approved.'); reload(); };
  rejectBtn.onclick = async () => { if (!confirm('Reject this recommendation?')) return; const x = await api('POST', `/api/admin/seo/recommendations/${rec.id}/reject`); if (!x.ok) return toast(x.data.error, true); toast('Rejected.'); reload(); };
  applyBtn.onclick = async () => {
    if (!confirm(`Apply this ${rec.type} change to the live site now? This is saved with full version history and can be rolled back from Site content → History.`)) return;
    const x = await api('POST', `/api/admin/seo/recommendations/${rec.id}/apply`);
    if (!x.ok) {
      // a 501 on a title/description recommendation can only be a refused TARGET (another site, or not the home page) — those two types are supported
      const manual = rec.type === 'title' || rec.type === 'description'
        ? 'This recommendation is not about this site\'s home page, so it cannot be applied automatically — the site-wide title and description only take home-page recommendations.'
        : 'This recommendation type needs to be implemented manually — it cannot be applied automatically.';
      toast(x.status === 501 ? manual : (x.data.error || 'Could not apply.'), true);
      if (x.status === 409 || x.status === 422) reload();   // the server has already moved this card on (or the content changed): show its real state, not a dead Apply button
      return;
    }
    toast('Applied — live on the site now.'); reload();
  };
  return h('article', { class: 'card' },
    h('div', { class: 'head' }, h('b', { text: rec.type }), h('span', { class: `pill ${rec.status === 'applied' ? 'ok' : rec.status === 'rejected' || rec.status === 'failed' ? 'bad' : 'info'}`, text: rec.status }), seoVerificationBadge(rec), h('span', { class: 'meta', text: `${rec.ai_provider || ''} ${rec.ai_model || ''}` })),
    rec.current_value ? h('p', { class: 'meta' }, h('b', { text: 'Current: ' }), rec.current_value) : null,
    h('p', { class: 'msg', text: rec.proposed_value }),
    h('p', { class: 'meta', text: rec.reasoning }),
    rec.status === 'failed' ? h('p', { class: 'meta', text: 'This recommendation can no longer be applied. A fresh recommendation may be needed — request one from an issue on the Issues tab.' }) : null,
    h('div', { class: 'row' }, rec.status === 'pending' ? [approveBtn, rejectBtn] : null, rec.status === 'approved' ? applyBtn : null));
}

/* ── History: past scans ── */
async function seoHistoryView(main) {
  main.append(h('p', { class: 'boot', text: 'Loading…' }));
  const r = await api('GET', '/api/admin/seo/scans');
  clear(main);
  if (!r.ok) return main.append(h('p', { class: 'empty', text: 'Could not load scan history.' }));
  main.append(!r.data.audits.length ? h('p', { class: 'empty', text: 'No scans yet.' }) : h('ul', { class: 'ulist' }, r.data.audits.map((a) =>
    h('li', {}, h('div', { class: 'who' }, h('b', { text: a.status === 'complete' ? `Score ${a.score}/100` : a.status }), h('span', { text: `${fmtDate(a.started_at)} · ${a.summary || `${seoFmt(a.pages_crawled)} page(s)`}` }))))));
}

/* ───────────── users (admins) ───────────── */
async function renderUsers(main) {
  const listBox = h('div', { class: 'panel' });
  const addName = h('input', { type: 'text', id: 'un', autocomplete: 'off' }), addEmail = h('input', { type: 'email', id: 'ue', autocomplete: 'off' });
  const addPw = h('input', { type: 'password', id: 'up', autocomplete: 'new-password' });
  const addRole = h('select', { id: 'ur' }, h('option', { value: 'editor', text: 'Editor — content & enquiries' }), h('option', { value: 'admin', text: 'Admin — everything, including users' }));
  const addErr = h('p', { class: 'err', role: 'alert' });
  const addForm = h('form', { class: 'panel', noValidate: true, onsubmit: async (e) => {
    e.preventDefault(); addErr.textContent = '';
    const r = await api('POST', '/api/admin/users', { name: addName.value, email: addEmail.value, password: addPw.value, role: addRole.value });
    if (!r.ok) { addErr.textContent = Object.values(r.data.errors || {})[0] || r.data.error || 'Could not add the user.'; return; }
    const usedPw = !!addPw.value; addName.value = addEmail.value = addPw.value = ''; toast(usedPw ? 'User added. Share the temporary password with them privately.' : 'User added — they can now sign in with Google.'); load();
  } },
    h('h2', { text: 'Add a user' }),
    h('p', { class: 'hint', text: googleOn ? 'Add their Google email and role. With no password, they sign in using the Google button. Or set a temporary password (10+ characters).' : 'Give them a temporary password (10+ characters) and ask them to change it under Account after signing in.' }),
    h('div', { class: 'fld' }, h('label', { for: 'un', text: 'Name' }), addName), h('div', { class: 'fld' }, h('label', { for: 'ue', text: 'Email' }), addEmail),
    h('div', { class: 'fld' }, h('label', { for: 'up', text: 'Temporary password (optional)' }), addPw, h('small', { class: 'help', text: googleOn ? 'Leave empty to invite them to Continue with Google — their Google email must match the one above.' : 'Google sign-in is not set up on this server, so a password is required.' })), h('div', { class: 'fld' }, h('label', { for: 'ur', text: 'Role' }), addRole),
    h('button', { class: 'btn btn--primary', type: 'submit', text: 'Add user' }), addErr);

  main.append(h('h1', { class: 'page-title' }, 'Users', h('small', { text: 'Who can sign in to this portal.' })), h('div', { class: 'two' }, listBox, addForm));

  async function load() {
    const r = await api('GET', '/api/admin/users');
    if (!r.ok) return listBox.replaceChildren(h('p', { class: 'empty', text: r.data.error || 'Could not load users.' }));
    listBox.replaceChildren(h('h2', { text: `${r.data.users.length} user${r.data.users.length > 1 ? 's' : ''}` }), h('ul', { class: 'ulist' }, r.data.users.map((u) => {
      const role = h('select', { 'aria-label': `Role for ${u.name}`, onchange: async () => { const x = await api('PATCH', `/api/admin/users/${u.id}`, { role: role.value }); if (!x.ok) toast(x.data.error || 'Could not change the role.', true); else toast('Role updated.'); load(); } },
        ['editor', 'admin'].map((r2) => h('option', { value: r2, text: r2, selected: r2 === u.role })));
      role.style.width = 'auto';
      return h('li', {}, h('div', { class: 'who' }, h('b', { text: u.name + (u.id === me.id ? ' (you)' : '') }), h('span', { text: `${u.email} · ${[u.googleLinked && 'Google', u.hasPassword && 'password'].filter(Boolean).join(' + ') || 'invited, not signed in yet'} · last sign-in ${fmtDate(u.last_login_at)}` })), role,
        h('button', { class: 'btn btn--sm', type: 'button', text: 'Reset password', onclick: () => resetPassword(u) }),
        h('button', { class: 'btn btn--sm btn--danger', type: 'button', text: 'Delete', disabled: u.id === me.id, onclick: async () => {
          if (!confirm(`Delete ${u.name} (${u.email})? They will be signed out immediately.`)) return;
          const x = await api('DELETE', `/api/admin/users/${u.id}`); if (!x.ok) toast(x.data.error || 'Could not delete.', true); else toast('User deleted.'); load();
        } }));
    })));
  }
  load();
}
function resetPassword(u) {
  const pw = h('input', { type: 'password', id: 'rp', autocomplete: 'new-password' });
  const err = h('p', { class: 'err', role: 'alert' });
  const modal = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Reset password' });
  const close = () => modal.remove();
  modal.onclick = (e) => e.target === modal && close();
  modal.addEventListener('keydown', (e) => e.key === 'Escape' && close());
  modal.append(h('form', { class: 'panel', noValidate: true, onsubmit: async (e) => {
    e.preventDefault(); err.textContent = '';
    const r = await api('PATCH', `/api/admin/users/${u.id}`, { password: pw.value });
    if (!r.ok) { err.textContent = (r.data.errors && r.data.errors.password) || r.data.error || 'Could not reset the password.'; return; }
    close(); toast(`Password reset for ${u.name}. They were signed out everywhere.`);
  } }, h('h2', { text: `New password for ${u.name}` }), h('div', { class: 'fld' }, h('label', { for: 'rp', text: 'New password (10+ characters)' }), pw), err,
    h('div', { class: 'row' }, h('button', { class: 'btn btn--primary', type: 'submit', text: 'Set password' }), h('button', { class: 'btn', type: 'button', text: 'Cancel', onclick: close }))));
  document.body.append(modal); pw.focus();
}

/* ───────────── account ───────────── */
function renderAccount(main) {
  const cur = h('input', { type: 'password', id: 'ac', autocomplete: 'current-password' }), nw = h('input', { type: 'password', id: 'an', autocomplete: 'new-password' }), rep = h('input', { type: 'password', id: 'ar', autocomplete: 'new-password' });
  const err = h('p', { class: 'err', role: 'alert' });
  main.append(h('h1', { class: 'page-title' }, 'Account'),
    h('div', { class: 'two' },
      h('section', { class: 'panel' }, h('h2', { text: 'Your details' }),
        h('p', {}, h('b', { text: me.name })), h('p', { class: 'meta', text: me.email }),
        h('p', {}, h('span', { class: 'role', text: me.role }), ' ', h('span', { class: 'meta', text: me.role === 'admin' ? 'Can edit everything and manage users.' : 'Can edit content and manage enquiries.' }))),
      !me.hasPassword ? h('section', { class: 'panel' }, h('h2', { text: 'Sign-in' }), h('p', { class: 'meta', text: 'You sign in with Google, so there is no password to manage here. Your Google account keeps you secure.' })) : h('form', { class: 'panel', noValidate: true, onsubmit: async (e) => {
        e.preventDefault(); err.textContent = '';
        if (nw.value !== rep.value) { err.textContent = 'The new passwords do not match.'; return; }
        const r = await api('POST', '/api/auth/password', { current: cur.value, next: nw.value });
        if (!r.ok) { err.textContent = Object.values(r.data.errors || {})[0] || r.data.error || 'Could not change the password.'; return; }
        cur.value = nw.value = rep.value = ''; toast('Password changed. Other devices were signed out.');
      } }, h('h2', { text: 'Change password' }),
      h('div', { class: 'fld' }, h('label', { for: 'ac', text: 'Current password' }), cur), h('div', { class: 'fld' }, h('label', { for: 'an', text: 'New password' }), nw, h('small', { class: 'help', text: 'At least 10 characters.' })),
      h('div', { class: 'fld' }, h('label', { for: 'ar', text: 'Repeat new password' }), rep), h('button', { class: 'btn btn--primary', type: 'submit', text: 'Change password' }), err)));
}

boot();
