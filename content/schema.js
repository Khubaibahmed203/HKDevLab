/**
 * The single definition of the site's editable content.
 *   • the admin editor builds its forms from it
 *   • the server validates and sanitises every save against it
 * Plain ES module, no dependencies — runs in Node and in the browser.
 *
 * Field types
 *   text     one line                      lines    a few short lines (\n allowed) — headings
 *   area     paragraph(s)                  href     "#anchor", /path, https://… or mailto:…
 *   select   one of `options`              color    #rrggbb
 *   bool     checkbox (`default` when missing)   list   list of one-line strings
 *   image    photo uploaded in the admin (stored as /media/<id>)
 *   url      a web address: http(s) only, a real host (see isWebUrl)
 *   numlist  list of numbers 0–100         obj      nested group (`fields`)
 *   objlist  repeatable group (`fields`)
 * Modifiers: max, min (length), maxItems, minItems, optional, when: { field: [values] }, itemLabel,
 *            default (bool), noun / wide (image: wording and a landscape thumbnail)
 * A field with `when` is only required (and only checked) while its condition holds, so a field that is not `optional`
 * but has `when: { kind: ['live'] }` is required for live projects only.
 */
export const ICONS = ['monitor', 'dashboard', 'cpu', 'code', 'zap', 'devices', 'heart', 'shield', 'rocket', 'globe', 'chat', 'chart', 'lock', 'star', 'users', 'layers'];
export const KINDS = [
  { value: 'live', label: 'Live project (screenshot of its landing page + link)' },   // first = what a new project starts as
  { value: 'hero', label: 'Sample · landing page (drawn mockup)' },
  { value: 'dash', label: 'Sample · dashboard (drawn mockup)' },
  { value: 'chat', label: 'Sample · chat / assistant (drawn mockup)' },
  { value: 'shop', label: 'Sample · online shop (drawn mockup)' },
];
const LIVE = { kind: ['live'] };
const MOCKS = ['hero', 'dash', 'chat', 'shop'];   // the drawn sample layouts — they use the two colours and the window address below

/** An address a visitor may be sent to: http(s) only, a real host, no embedded login, no spaces. Used by the server and the admin form. */
export function isWebUrl(s) {
  if (typeof s !== 'string' || /\s/.test(s)) return false;
  try {
    const u = new URL(s);
    return /^https?:$/.test(u.protocol) && u.hostname.includes('.') && !u.username && !u.password;
  } catch { return false; }
}

const text = (k, label, o = {}) => ({ k, label, type: 'text', max: 120, ...o });
const lines = (k, label, o = {}) => ({ k, label, type: 'lines', max: 120, help: 'Press Enter for a new line.', ...o });
const area = (k, label, o = {}) => ({ k, label, type: 'area', max: 600, ...o });
const list = (k, label, o = {}) => ({ k, label, type: 'list', max: 80, ...o });
const obj = (k, label, fields, o = {}) => ({ k, label, type: 'obj', fields, ...o });
const objlist = (k, label, fields, o = {}) => ({ k, label, type: 'objlist', fields, ...o });
const href = (k, label, o = {}) => ({ k, label, type: 'href', max: 300, ...o });
const weburl = (k, label, o = {}) => ({ k, label, type: 'url', max: 300, ...o });

const link = (k, label) => obj(k, label, [text('label', 'Button text', { max: 40 }), href('href', 'Goes to', { help: 'Use #contact, #work… for sections on this page, or a full https:// address.' })]);
const icon = () => ({ k: 'icon', label: 'Icon', type: 'select', options: ICONS });

export const SCHEMA = [
  {
    key: 'seo', label: 'Search & sharing', hint: 'What Google and social media show for the site.',
    fields: [
      text('title', 'Page title', { max: 70, help: 'Keep under about 60 characters.' }),
      area('description', 'Description', { max: 200, help: 'One or two sentences, up to about 160 characters.' }),
    ],
  },
  {
    key: 'hero', label: 'Hero (top of page)',
    fields: [
      text('eyebrow', 'Small line above the logo', { max: 60 }),
      list('chips', 'Floating tags (exactly 4)', { max: 20, minItems: 4, maxItems: 4 }),
      area('lede', 'Intro paragraph', { max: 300 }),
      link('ctaPrimary', 'Main button'),
      link('ctaSecondary', 'Second button'),
      list('sideLeft', 'Left edge words', { max: 20, maxItems: 6, optional: true }),
      list('sideRight', 'Right edge words', { max: 20, maxItems: 6, optional: true }),
    ],
  },
  {
    key: 'lab', label: 'The Lab (what we do)',
    fields: [
      text('eyebrow', 'Section label', { max: 50 }),
      area('statement', 'Big statement', { max: 300, help: 'Put *asterisks* around words to highlight them in blue.' }),
      text('stackEyebrow', 'Stack label', { max: 50 }),
      lines('stackTitle', 'Stack headline'),
      objlist('tiles', 'Tech stack tiles (they fly past as you scroll)', [text('text', 'Name', { max: 30 }), { k: 'hot', label: 'Highlight', type: 'bool' }], { minItems: 3, maxItems: 16, itemLabel: 'text' }),
      objlist('services', 'Services', [icon(), text('title', 'Title', { max: 40 }), area('text', 'Description', { max: 200 })], { minItems: 1, maxItems: 8, itemLabel: 'title' }),
      objlist('principles', 'Principles', [icon(), text('title', 'Title', { max: 40 }), area('text', 'Description', { max: 160 })], { minItems: 1, maxItems: 8, itemLabel: 'title' }),
    ],
  },
  {
    key: 'founders', label: 'Founders (about)',
    hint: 'Portrait cards shown at the end of The Lab section. For each founder: a photo, name, role, a short bio and a portfolio link.',
    fields: [
      { k: 'show', label: 'Show this section on the site', type: 'bool' },
      text('eyebrow', 'Section label', { max: 50 }),
      lines('title', 'Headline', { help: 'The last line is shown in blue.' }),
      area('intro', 'Intro paragraph (optional)', { max: 240, optional: true }),
      objlist('people', 'Founders', [
        { k: 'photo', label: 'Portrait photo', type: 'image', optional: true, help: 'JPG, PNG or WebP. A head-and-shoulders portrait works best — it is shown in a tall 4:5 frame, cropped from the centre-top. Without a photo, a monogram of their initials is shown.' },
        text('name', 'Name', { max: 50 }),
        text('role', 'Role / title', { max: 60 }),
        area('bio', 'About', { max: 420, help: 'Two or three sentences.' }),
        text('linkLabel', 'Portfolio button text', { max: 30, optional: true, help: 'Leave empty for "View portfolio".' }),
        href('link', 'Portfolio link', { optional: true, help: 'The full https:// address of their portfolio. Leave empty to hide the button.' }),
      ], { minItems: 1, maxItems: 4, itemLabel: 'name' }),
    ],
  },
  {
    key: 'process', label: 'Process (idea → launch)',
    fields: [
      text('eyebrow', 'Section label', { max: 50 }),
      lines('title', 'Headline'),
      lines('hint', 'Scroll hint (small text)', { max: 90, optional: true }),
      objlist('steps', 'Steps', [text('title', 'Step name', { max: 30 }), area('text', 'Description', { max: 260 }), list('tags', 'Tags', { max: 30, maxItems: 5, optional: true })], { minItems: 3, maxItems: 8, itemLabel: 'title' }),
    ],
  },
  {
    key: 'work', label: 'Selected Concepts (projects)',
    hint: 'Each project is a browser window on the website. Their order here is the order on the site — use the arrows. A project shows on the site only while it is Featured and Published; untick either to keep it here without showing it. Everything goes live when you click "Save changes".',
    fields: [
      text('eyebrow', 'Section label', { max: 50 }),
      text('title', 'Headline', { max: 60 }),
      area('note', 'Note under the headline', { max: 200, optional: true }),
      objlist('items', 'Projects', [
        text('name', 'Project name', { max: 40 }),
        text('meta', 'Category', { max: 70, help: 'Shown under the name, e.g. "Website · Online shop".' }),
        { k: 'featured', label: 'Featured — show in Selected Concepts', type: 'bool', default: true },
        { k: 'published', label: 'Published — untick to keep it as a draft (hidden from visitors)', type: 'bool', default: true },
        { k: 'kind', label: 'Layout', type: 'select', options: KINDS },
        area('description', 'Short description', { max: 180, when: LIVE, help: 'One or two sentences about the project.' }),
        list('technologies', 'Technologies', { max: 24, maxItems: 8, when: LIVE, help: 'Up to 8, e.g. React, Node.js, PostgreSQL.' }),
        weburl('liveUrl', 'Live website URL', { when: LIVE, help: 'The full address, e.g. https://example-project.vercel.app/. "View live", the project and its name all open it in a new tab.' }),
        weburl('githubUrl', 'GitHub URL (optional)', { optional: true, when: LIVE, help: 'Shown as a small "GitHub" link next to "View live". Leave empty to hide it.' }),
        { k: 'preview', label: 'Landing-page screenshot', type: 'image', noun: 'screenshot', wide: true, optional: true, when: LIVE, help: 'A screenshot of the project\'s landing page (landscape, about 16:9), shown inside the browser window. Without one the card shows the project name.' },
        text('url', 'Web address shown in the window', { max: 60, when: { kind: MOCKS } }),
        { k: 'a', label: 'Colour 1', type: 'color', when: { kind: MOCKS } },
        { k: 'b', label: 'Colour 2', type: 'color', when: { kind: MOCKS } },
        lines('title', 'Headline', { when: { kind: ['hero', 'shop'] } }),
        text('sub', 'Sub-text', { max: 90, optional: true, when: { kind: ['hero'] } }),
        text('cta', 'Button text', { max: 30, optional: true, when: { kind: ['hero'] } }),
        list('nav', 'Menu items (up to 3)', { max: 20, maxItems: 3, optional: true, when: { kind: ['hero', 'shop'] } }),
        objlist('kpis', 'Number cards (up to 3)', [text('label', 'Label', { max: 20 }), text('value', 'Value', { max: 12 })], { maxItems: 3, optional: true, when: { kind: ['dash'] } }),
        { k: 'bars', label: 'Chart bars (numbers 0–100)', type: 'numlist', maxItems: 12, optional: true, when: { kind: ['dash'] } },
        objlist('chat', 'Chat messages (up to 4)', [text('text', 'Message', { max: 90 }), { k: 'mine', label: 'From the customer', type: 'bool' }], { maxItems: 4, optional: true, when: { kind: ['chat'] } }),
      ], { maxItems: 24, itemLabel: 'name' }),
    ],
  },
  {
    key: 'who', label: 'Built for (audience band)',
    fields: [
      text('eyebrow', 'Section label', { max: 50 }),
      list('items', 'Who you work with', { max: 40, minItems: 2, maxItems: 10 }),
    ],
  },
  {
    key: 'contact', label: 'Contact & footer',
    fields: [
      text('eyebrow', 'Section label', { max: 50 }),
      lines('title', 'Headline', { help: 'The last line is shown in blue.' }),
      area('lede', 'Intro paragraph', { max: 300 }),
      text('email', 'Public email address', { max: 120, help: 'Shown on the site. Enquiries are emailed to the address set on the server (MAIL_TO).' }),
      objlist('socials', 'Social links', [text('label', 'Name', { max: 30 }), href('href', 'Address')], { maxItems: 8, optional: true, itemLabel: 'label' }),
      text('location', 'Location line (optional)', { max: 80, optional: true }),
      list('formTypes', 'Options in the "What do you need?" menu', { max: 50, minItems: 1, maxItems: 10 }),
    ],
  },
  {
    key: 'footer', label: 'Footer',
    fields: [text('copyright', 'Copyright text (after © and the year)', { max: 100 })],
  },
];
