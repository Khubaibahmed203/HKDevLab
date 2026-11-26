import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCHEMA, normalizeWebUrl } from '../content/schema.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_CONTENT = JSON.parse(readFileSync(resolve(root, 'content/default.json'), 'utf8'));

const CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const HREF = /^(#[\w-]*|\/[^\s]*|https?:\/\/[^\s"'<>]+|mailto:[^\s"'<>]+)$/i;
const COLOR = /^#[0-9a-f]{6}$/i;
export const MEDIA_URL = /^\/media\/[a-f0-9]{32}$/;          // the only image address content may hold: a photo uploaded through the admin

const oneLine = (v) => (typeof v === 'string' ? v : '').replace(CTRL, '').replace(/[\r\n\t]+/g, ' ').trim();
const multiLine = (v) => (typeof v === 'string' ? v : '').replace(/\r\n?/g, '\n').replace(CTRL, '').trim();

/** Applies a field definition to raw input; returns the clean value and pushes problems to `errors`. */
function clean(f, raw, path, errors, parent) {
  const applies = !f.when || Object.entries(f.when).every(([k, vals]) => vals.includes(parent?.[k]));
  const fail = (msg) => { if (applies) errors.push({ path, message: msg }); };
  const label = f.label || f.k;

  switch (f.type) {
    case 'text': case 'href': case 'url': case 'select': case 'color': case 'image': {
      const s = oneLine(raw);
      if (!s) { if (!f.optional) fail(`${label} can't be empty.`); return ''; }
      if (s.length > (f.max ?? 200)) { fail(`${label} is too long (max ${f.max} characters).`); return s.slice(0, f.max); }
      if (f.type === 'href' && !HREF.test(s)) fail(`${label} must start with #, /, https://, http:// or mailto:`);
      if (f.type === 'url') {                                   // saved normalised: https://Example.com → https://example.com/
        const n = normalizeWebUrl(s);
        if (!n) fail(`${label} must be a full web address such as https://example.com/ (http or https, no spaces).`);
        else return n;
      }
      if (f.type === 'color' && !COLOR.test(s)) fail(`${label} must be a colour like #12a6ff.`);
      if (f.type === 'image' && !MEDIA_URL.test(s)) { fail(`${label} must be a photo uploaded here.`); return ''; }
      if (f.type === 'select') {
        const allowed = f.options.map((o) => (typeof o === 'string' ? o : o.value));
        if (!allowed.includes(s)) { fail(`${label} has an unknown option.`); return allowed[0]; }
      }
      return s;
    }
    case 'lines': case 'area': {
      const s = f.type === 'lines' ? multiLine(raw).split('\n').map((l) => l.trim()).filter(Boolean).join('\n') : multiLine(raw);
      if (!s) { if (!f.optional) fail(`${label} can't be empty.`); return ''; }
      if (s.length > (f.max ?? 2000)) { fail(`${label} is too long (max ${f.max} characters).`); return s.slice(0, f.max); }
      return s;
    }
    case 'bool': return raw === undefined ? f.default === true : raw === true;      // a flag missing from older content takes its default
    case 'list': {
      const arr = (Array.isArray(raw) ? raw : []).map((x, i) => {
        const s = oneLine(x);
        if (s.length > (f.max ?? 80)) fail(`${label} item ${i + 1} is too long (max ${f.max}).`);
        return s.slice(0, f.max ?? 80);
      }).filter(Boolean);
      return bounded(f, arr, label, fail);
    }
    case 'numlist': {
      const arr = (Array.isArray(raw) ? raw : []).map(Number).filter((n) => Number.isFinite(n)).map((n) => Math.min(100, Math.max(0, Math.round(n))));
      return bounded(f, arr, label, fail);
    }
    case 'obj': return cleanObject(f.fields, raw, path, errors, applies);
    case 'objlist': {
      const arr = (Array.isArray(raw) ? raw : []).slice(0, (f.maxItems ?? 50) + 1)
        .map((item, i) => cleanObject(f.fields, item, `${path}[${i}]`, errors, applies));
      return bounded(f, arr, label, fail);
    }
    default: return null;
  }
}

function bounded(f, arr, label, fail) {
  if (f.minItems && arr.length < f.minItems) fail(`${label} needs at least ${f.minItems} item${f.minItems > 1 ? 's' : ''}.`);
  if (f.maxItems && arr.length > f.maxItems) { fail(`${label} allows at most ${f.maxItems} items.`); return arr.slice(0, f.maxItems); }
  return arr;
}

function cleanObject(fields, raw, path, errors, applies = true) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const f of fields) out[f.k] = clean(f, src[f.k], path ? `${path}.${f.k}` : f.k, applies ? errors : [], out);
  return out;
}

/** Validates a whole content document. Returns { value } or { errors }. */
export function sanitizeContent(input) {
  const errors = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { errors: [{ path: '', message: 'Content must be an object.' }] };
  if (JSON.stringify(input).length > 200_000) return { errors: [{ path: '', message: 'Content is too large.' }] };
  const value = {};
  for (const section of SCHEMA) value[section.key] = cleanObject(section.fields, input[section.key], section.key, errors);
  return errors.length ? { errors } : { value };
}

/** Fills in any section a stored document lacks (e.g. after an upgrade) from the defaults — and, inside a stored section,
 *  any field it lacks (a field added by an upgrade, such as contact.whatsapp). Never replaces anything that was saved:
 *  a field that exists in the stored section, even an empty one, is kept exactly as it is. */
export function withDefaults(stored) {
  const out = { ...DEFAULT_CONTENT };
  for (const k of Object.keys(DEFAULT_CONTENT)) {
    const s = stored?.[k];
    if (!s || typeof s !== 'object') continue;
    const d = DEFAULT_CONTENT[k];
    out[k] = Array.isArray(s) || !d || typeof d !== 'object' || Array.isArray(d) ? s : { ...d, ...s };
  }
  return out;
}
