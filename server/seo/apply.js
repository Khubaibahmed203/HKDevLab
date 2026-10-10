import { DEFAULT_CONTENT, sanitizeContent, withDefaults } from '../content.js';

/**
 * Which recommendation types can be safely auto-applied today, and how. Only fields that already exist in
 * the CMS schema — and therefore already go through sanitizeContent() + the versioned content write (validation,
 * version history, rollback) — are eligible. Everything else returns "manual implementation required"
 * rather than making an unreviewable, unrollback-able change. Never executes anything AI-generated as code:
 * this only ever writes a string into one already-known, already-validated content field.
 *
 * The write is a compare-and-swap on the content version read together with the document: if anything else saved
 * in between (an editor, a restore, another apply), nothing is written and the result is `conflict`. There is
 * deliberately no automatic re-read and retry — a person decides whether the recommendation still fits the new content.
 *
 * TARGET BINDING: what this writes is the ONE site-wide seo.title / seo.description, i.e. the home page's. So before anything is read
 * or written the recommendation must prove it is about that target: it must belong to the configured home website (`homeWebsite`, passed
 * in by the caller — the same row the rest of the SEO routes resolve) and, when it names a page, that page must be the home page "/" of
 * that website. A recommendation about another website or another page is not applied here — it gets the same "manual implementation
 * required" answer an unsupported type gets, with no content read, write or history entry. A recommendation with no page at all
 * (page_id null) stays applicable. A caller that supplies no home website is refused rather than trusted.
 */
export async function applyRecommendation(store, rec, { userEmail, homeWebsite }) {
  if (rec.type === 'title' || rec.type === 'description') {
    if (!(await targetsHomePage(store, rec, homeWebsite))) return { ok: false, error: 'manual implementation required' };
    const row = await store.getContent();
    const current = row ? withDefaults(row.data) : DEFAULT_CONTENT;
    const version = row ? row.version : 0;
    const draft = JSON.parse(JSON.stringify(current));
    draft.seo[rec.type] = rec.proposed_value;

    const { errors, value } = sanitizeContent(draft);
    if (errors) return { ok: false, error: 'The proposed value failed content validation.', details: errors };

    // The proposed value is already live in this one field: there is nothing to write (and no identical history entry to add).
    if (current.seo[rec.type] === value.seo[rec.type]) return { ok: true, unchanged: true };

    // STALE VALUE: `base_value` is the site's own value of this one field when the recommendation was created (never the crawled
    // `current_value`). If the field has changed since, this proposal was written against text that is no longer live — nothing is
    // written. A NULL base (older rows, or none recorded) means no guard. Only this field is compared, so edits to anything else
    // never block it. This is NOT the compare-and-swap conflict below (which is a race during this very request).
    if (rec.base_value != null && current.seo[rec.type] !== rec.base_value) {
      return { ok: false, stale: true, error: `The site's SEO ${rec.type} changed after this recommendation was drafted, so nothing was written. Generate a new recommendation from the Issues tab.` };
    }

    const saved = await store.saveContentIfVersion(value, userEmail, `Applied AI SEO recommendation #${rec.id}`, version);
    if (!saved.ok) return { ok: false, conflict: true, error: 'The site content changed while this recommendation was being applied, so nothing was written. Review the current content, then apply it again if it still fits.' };
    return { ok: true };
  }
  return { ok: false, error: 'manual implementation required' };
}

/** True only when `rec` belongs to the home website and is either page-less or about that website's own home page "/". Fails closed. */
async function targetsHomePage(store, rec, homeWebsite) {
  const homeId = Number(homeWebsite?.id);
  if (!Number.isInteger(homeId) || homeId <= 0 || Number(rec.website_id) !== homeId) return false;
  if (rec.page_id == null) return true;
  const page = await store.getPage(rec.page_id);
  return !!page && Number(page.website_id) === homeId && isHomeRoot(page.url, homeWebsite.domain);
}

/** The crawler stores a page as its normalized absolute URL. The home page is that site's root path on the site's own host — no query, no credentials. */
function isHomeRoot(url, domain) {
  let u;
  try { u = new URL(url); } catch { return false; }
  return /^https?:$/.test(u.protocol) && u.host.toLowerCase() === String(domain).toLowerCase() && u.pathname === '/' && !u.search && !u.username && !u.password;
}
