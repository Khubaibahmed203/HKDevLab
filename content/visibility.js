/**
 * Which Selected Concepts the public site may show. Plain ES module, no dependencies — the server applies it before any
 * content leaves for a visitor (so a draft is never sent to the browser), and the page applies it to its offline fallback.
 * A concept is shown only while it is BOTH published (not a draft) and featured. A flag that is missing — content saved
 * before the flags existed — counts as ON, so existing concepts keep showing.
 */
export const isShown = (w) => w.published !== false && w.featured !== false;

/**
 * May this concept be shown as a live iframe? Only when the server's check of its Live URL said the site allows being
 * embedded AND that check was for the address that is saved now (an edited address is "unknown" until the next save re-checks it).
 */
export const canEmbed = (w) => w.kind === 'live' && w.embed === 'ok' && !!w.liveUrl && w.embedUrl === w.liveUrl;
/** …or does the site refuse to be embedded (so the card shows its fallback instead of a blank frame)? */
export const embedBlocked = (w) => w.kind === 'live' && w.embed === 'blocked' && !!w.liveUrl && w.embedUrl === w.liveUrl;

export const publicContent =(content) => ({ ...content, work: { ...content.work, items: (content.work?.items || []).filter(isShown) } });
