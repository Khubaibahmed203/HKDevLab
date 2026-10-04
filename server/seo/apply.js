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
 */
export async function applyRecommendation(store, rec, { userEmail }) {
  if (rec.type === 'title' || rec.type === 'description') {
    const row = await store.getContent();
    const current = row ? withDefaults(row.data) : DEFAULT_CONTENT;
    const version = row ? row.version : 0;
    const draft = JSON.parse(JSON.stringify(current));
    draft.seo[rec.type] = rec.proposed_value;

    const { errors, value } = sanitizeContent(draft);
    if (errors) return { ok: false, error: 'The proposed value failed content validation.', details: errors };

    // The proposed value is already live in this one field: there is nothing to write (and no identical history entry to add).
    if (current.seo[rec.type] === value.seo[rec.type]) return { ok: true, unchanged: true };

    const saved = await store.saveContentIfVersion(value, userEmail, `Applied AI SEO recommendation #${rec.id}`, version);
    if (!saved.ok) return { ok: false, conflict: true, error: 'The site content changed while this recommendation was being applied, so nothing was written. Review the current content, then apply it again if it still fits.' };
    return { ok: true };
  }
  return { ok: false, error: 'manual implementation required' };
}
