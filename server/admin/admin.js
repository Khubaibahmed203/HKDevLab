import { SCHEMA } from '/admin/schema.js';

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
  const tabs = [['content', 'Site content'], ['enquiries', 'Enquiries'], ...(me.role === 'admin' ? [['users', 'Users']] : []), ['account', 'Account']];
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
  ({ content: renderContent, enquiries: renderEnquiries, users: renderUsers, account: renderAccount })[view](main);
}

/* ───────────── content editor (built from the shared schema) ───────────── */
const applies = (f, obj) => !f.when || Object.entries(f.when).every(([k, v]) => v.includes(obj[k]));
const optVal = (o) => (typeof o === 'string' ? o : o.value);
const optLabel = (o) => (typeof o === 'string' ? o : o.label);
function blank(f) {
  switch (f.type) {
    case 'select': return optVal(f.options[0]);
    case 'color': return '#12a6ff';
    case 'bool': return false;
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
    case 'list': return listField(f, obj, touch);
    case 'obj': return h('div', { class: 'fs' }, h('div', { class: 'lbl', text: f.label }), group(f.fields, obj[f.k], touch), f.help && h('small', { class: 'help', text: f.help }));
    case 'objlist': return objlistField(f, obj, touch);
    default: return h('div');
  }
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

const openState = new WeakMap();
function objlistField(f, obj, touch) {
  const arr = obj[f.k];
  const compact = f.fields.length <= 2;
  const box = h('div', { class: 'fs' });
  const move = (i, d) => { [arr[i], arr[i + d]] = [arr[i + d], arr[i]]; touch(); draw(); };
  const remove = (i) => { arr.splice(i, 1); touch(); draw(); };
  const titleOf = (item, i) => (f.itemLabel && String(item[f.itemLabel] || '').trim()) || `Item ${i + 1}`;

  const draw = () => {
    const items = arr.map((item, i) => {
      ensure(f.fields, item);
      const controls = [
        iconBtn('↑', 'Move up', () => move(i, -1), i === 0), iconBtn('↓', 'Move down', () => move(i, 1), i === arr.length - 1),
        iconBtn('✕', 'Remove', () => remove(i), f.minItems && arr.length <= f.minItems),
      ];
      if (compact) return h('div', { class: 'row--compact' }, group(f.fields, item, touch), h('div', { class: 'row' }, controls));
      const ttl = h('span', { class: 'ttl', text: titleOf(item, i) });
      const liveTouch = () => { ttl.textContent = titleOf(item, i); touch(); };
      const d = h('details', { class: 'item' },
        h('summary', {}, h('span', { class: 'num', text: String(i + 1).padStart(2, '0') }), ttl, ...controls),
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
    draft = r.data.content; saved = JSON.stringify(draft); meta = { updatedAt: r.data.updatedAt, updatedBy: r.data.updatedBy };
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
    const r = await api('PUT', '/api/admin/content', { content: draft });
    if (r.ok) {
      draft = r.data.content; saved = JSON.stringify(draft); meta = { updatedAt: r.data.updatedAt, updatedBy: r.data.updatedBy }; errors = [];
      toast('Saved — the change is live on the site now.');
    } else if (r.data.errors) { errors = r.data.errors; toast('Some fields need attention — see the list below.', true); }
    else toast(r.data.error || 'Could not save.', true);
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
          if (res.ok) { draft = res.data.content; saved = JSON.stringify(draft); meta = { updatedAt: res.data.updatedAt, updatedBy: res.data.updatedBy }; errors = []; close(); render(); toast('Version restored and live.'); }
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
