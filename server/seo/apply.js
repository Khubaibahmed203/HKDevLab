import { DEFAULT_CONTENT, sanitizeContent, withDefaults } from '../content.js';

/**
 * Which recommendation types can be safely auto-applied today, and how. Only fields that already exist in
 * the CMS schema — and therefore already go through sanitizeContent() + saveContent() (validation,
 * version history, rollback) — are eligible. Everything else returns "manual implementation required"
 * rather than making an unreviewable, unrollback-able change. Never executes anything AI-generated as code:
 * this only ever writes a string into one already-known, already-validated content field.
 */
export async function applyRecommendation(store, rec, { userEmail }) {
  if (rec.type === 'title' || rec.type === 'description') {
    const row = await store.getContent();
    const current = row ? withDefaults(row.data) : DEFAULT_CONTENT;
    const draft = JSON.parse(JSON.stringify(current));
    draft.seo[rec.type] = rec.proposed_value;

    const { errors, value } = sanitizeContent(draft);
    if (errors) return { ok: false, error: 'The proposed value failed content validation.', details: errors };

    await store.saveContent(value, userEmail, `Applied AI SEO recommendation #${rec.id}`);
    return { ok: true };
  }
  return { ok: false, error: 'manual implementation required' };
}
