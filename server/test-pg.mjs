// Exercises the PostgreSQL code path against an in-memory Postgres emulator (pg-mem).
// Run: node server/test-pg.mjs
import { newDb } from 'pg-mem';
import { createStore } from './db.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { (cond ? pass++ : fail++); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };

const { Pool } = newDb().adapters.createPg();
const pool = new Pool();
const store = await createStore({ pool });
ok('reports the postgres backend', store.kind === 'postgres');
await store.ping();

// enquiries
const id = await store.insert({ name: 'A B', email: 'a@b.co', service: 'X', message: 'hello there world', ipHash: 'h', userAgent: 'ua' });
ok('insert returns a numeric id', typeof id === 'number' && id > 0);
let rows = await store.list();
ok('list returns the row with a boolean email_sent', rows.length === 1 && rows[0].email_sent === false && typeof rows[0].id === 'number');
await store.setEmailed(id, true);
ok('setEmailed', (await store.list())[0].email_sent === true);
ok('setStatus', (await store.setStatus(id, 'read')) === true && (await store.counts()).read === 1);
ok('filtered list', (await store.list({ status: 'read' })).length === 1 && (await store.list({ status: 'new' })).length === 0);

// users
ok('no users yet', (await store.userCount()) === 0);

// atomic first user + shared rate limiting (both exist so several server copies can share one database safely)
const [f1, f2] = await Promise.all([
  store.createFirstUser({ email: 'first@x.co', name: 'First', passwordHash: 'h', role: 'admin' }),
  store.createFirstUser({ email: 'second@x.co', name: 'Second', passwordHash: 'h', role: 'admin' }),
]);
ok('createFirstUser: of two simultaneous attempts exactly one wins', [f1, f2].filter(Boolean).length === 1 && (await store.userCount()) === 1, JSON.stringify([f1, f2]));
ok('createFirstUser refuses once a user exists (returns null)', (await store.createFirstUser({ email: 'third@x.co', name: 'Third', passwordHash: 'h', role: 'admin' })) === null);
await store.deleteUser(f1 || f2);
ok('table is empty again for the next tests', (await store.userCount()) === 0);
await store.rateHit('k1'); await store.rateHit('k1');
ok('rateCount counts hits inside the window', (await store.rateCount('k1', 60000)) === 2 && (await store.rateCount('other', 60000)) === 0);
ok('hits outside the window are ignored', (await store.rateCount('k1', -1)) === 0);
await store.rateClear('k1');
ok('rateClear forgets a key', (await store.rateCount('k1', 60000)) === 0);
const uid = await store.createUser({ email: 'o@x.co', name: 'Owner', passwordHash: 'hash', role: 'admin' });
ok('createUser + counts', (await store.userCount()) === 1 && (await store.adminCount()) === 1);
ok('userByEmail includes hash, userById does not', (await store.userByEmail('o@x.co')).password_hash === 'hash' && !('password_hash' in (await store.userById(uid))));
await store.updateUser(uid, { name: 'Renamed', role: 'editor' });
ok('updateUser', (await store.userById(uid)).name === 'Renamed' && (await store.adminCount()) === 0);
await store.touchLogin(uid);
ok('touchLogin', !!(await store.userById(uid)).last_login_at);
let dup = false; try { await store.createUser({ email: 'o@x.co', name: 'Dup', passwordHash: 'h', role: 'editor' }); } catch { dup = true; }
ok('unique email enforced', dup);

// google linking + one-time oauth state
ok('new user starts unlinked, invited (no password)', (await store.userById(uid)).googleLinked === false && (await store.userById(uid)).hasPassword === false);
await store.linkGoogle(uid, 'sub-123');
ok('linkGoogle + userByGoogleSub', (await store.userByGoogleSub('sub-123')).email === 'o@x.co' && (await store.userById(uid)).googleLinked === true);
ok('unknown sub → null', (await store.userByGoogleSub('nope')) === null);
const inFuture = new Date(Date.now() + 60000).toISOString(), inPast = new Date(Date.now() - 1000).toISOString();
await store.createOAuthState({ hash: 'h1', verifier: 'v', nonce: 'n', setupOk: true, expiresAt: inFuture });
const taken = await store.takeOAuthState('h1');
ok('oauth state can be taken once', taken && taken.verifier === 'v' && taken.nonce === 'n' && taken.setupOk === true);
ok('…and never again (replay)', (await store.takeOAuthState('h1')) === null);
await store.createOAuthState({ hash: 'h2', verifier: 'v', nonce: 'n', setupOk: false, expiresAt: inPast });
ok('expired oauth state is refused', (await store.takeOAuthState('h2')) === null);

// sessions
const future = new Date(Date.now() + 864e5).toISOString(), past = new Date(Date.now() - 1000).toISOString();
await store.createSession(uid, 'tok1', future, 'ua');
ok('valid session resolves to the user', (await store.sessionUser('tok1'))?.email === 'o@x.co');
await store.createSession(uid, 'tok2', past, 'ua');
ok('expired session does not resolve', (await store.sessionUser('tok2')) === null);
await store.createSession(uid, 'tok3', future, 'ua');
await store.deleteUserSessions(uid, 'tok1');
ok('deleteUserSessions keeps the excepted one', (await store.sessionUser('tok1')) && !(await store.sessionUser('tok3')));
await store.deleteSession('tok1');
ok('deleteSession', (await store.sessionUser('tok1')) === null);

// content + versions
ok('no content yet', (await store.getContent()) === null);
await store.saveContent({ a: 1 }, 'o@x.co', 'first');
await store.saveContent({ a: 2 }, 'o@x.co', 'second');
ok('saveContent updates in place', (await store.getContent()).data.a === 2);
const vs = await store.listVersions();
ok('versions listed newest first', vs.length === 2 && vs[0].note === 'second' && typeof vs[0].id === 'number');
ok('getVersion', (await store.getVersion(vs[1].id)).a === 1);
for (let i = 0; i < 45; i++) await store.saveContent({ a: 100 + i }, 'o@x.co', `n${i}`);
ok('version history is capped at 40', (await store.listVersions()).length === 40);

// uploaded photos (stored as base64 text)
const photo = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 1, 2, 3, 250, 251, 252, 253, 254, 255, 0, 0, 9]);
await store.saveMedia({ id: 'a'.repeat(32), mime: 'image/jpeg', bytes: photo, by: 'o@x.co' });
await store.saveMedia({ id: 'a'.repeat(32), mime: 'image/jpeg', bytes: photo, by: 'o@x.co' });      // same id again: ignored, no error
const gotPhoto = await store.getMedia('a'.repeat(32));
ok('media: bytes round-trip exactly (incl. 0x00 and 0xFF)', gotPhoto && Buffer.isBuffer(gotPhoto.bytes) && gotPhoto.bytes.equals(photo) && gotPhoto.mime === 'image/jpeg');
ok('media: unknown id → null', (await store.getMedia('b'.repeat(32))) === null);

// SEO Agent foundation (Phase 1): websites, pages, audits, issues
const w1 = await store.ensureWebsite('hkdevlab.com', 'HK DevLab');
ok('ensureWebsite creates a row', typeof w1.id === 'number' && w1.domain === 'hkdevlab.com');
const w2 = await store.ensureWebsite('hkdevlab.com', 'HK DevLab');
ok('ensureWebsite is idempotent (same domain → same row)', w2.id === w1.id);
ok('getWebsite', (await store.getWebsite(w1.id)).domain === 'hkdevlab.com');

const pageId = await store.upsertPage({ websiteId: w1.id, url: 'https://hkdevlab.com/', title: 'T', description: 'D', statusCode: 200 });
ok('upsertPage inserts', typeof pageId === 'number');
const pageId2 = await store.upsertPage({ websiteId: w1.id, url: 'https://hkdevlab.com/', title: 'T2', description: 'D2', statusCode: 200 });
ok('upsertPage updates the same row for the same (website, url)', pageId2 === pageId);
ok('listPages reflects the update', (await store.listPages(w1.id))[0].title === 'T2');

const auditRow = await store.createAudit(w1.id);
ok('createAudit starts running', auditRow.status === 'running' && typeof auditRow.id === 'number');
await store.createIssues(w1.id, auditRow.id, [
  { type: 'missing-title', severity: 'critical', detail: 'x', recommendation: 'y' },
  { type: 'title-length', severity: 'warning', detail: 'x', recommendation: null },
]);
await store.finishAudit(auditRow.id, { score: 80, status: 'complete', summary: '2 issue(s) found.' });
const finished = await store.getAudit(auditRow.id);
ok('finishAudit + getAudit', finished.status === 'complete' && finished.score === 80 && !!finished.finished_at);
ok('latestAudit returns the same row', (await store.latestAudit(w1.id)).id === auditRow.id);

const allIssues = await store.listIssues({ websiteId: w1.id });
ok('listIssues returns both issues, newest first', allIssues.length === 2 && allIssues[0].type === 'title-length');
const critOnly = await store.listIssues({ websiteId: w1.id, severity: 'critical' });
ok('listIssues filters by severity', critOnly.length === 1 && critOnly[0].type === 'missing-title');
ok('listIssues filters by type (partial match)', (await store.listIssues({ websiteId: w1.id, type: 'title-length' })).length === 1);
ok('issueCountsBySeverity', (await store.issueCountsBySeverity(auditRow.id)).critical === 1 && (await store.issueCountsBySeverity(auditRow.id)).warning === 1 && (await store.issueCountsBySeverity(auditRow.id)).total === 2);
ok('getIssue', (await store.getIssue(allIssues[0].id)).type === allIssues[0].type);

// Phase 2: the full page-facts upsert (not just the Phase 1 subset), the link graph, recommendations, and audit history
const pageId3 = await store.upsertPage({
  websiteId: w1.id, url: 'https://hkdevlab.com/services', finalUrl: 'https://hkdevlab.com/services', statusCode: 200,
  contentType: 'text/html', title: 'Services', description: 'D', canonical: 'https://hkdevlab.com/services', robots: '',
  h1Count: 1, h2Count: 3, wordCount: 500, htmlSize: 12000, responseTimeMs: 120, depth: 1, imageCount: 4, imagesMissingAlt: 1,
  lang: 'en', ogTitle: 'Services', ogDescription: 'D', ogImage: '/og.jpg', twitterCard: 'summary', jsonLdPresent: true, auditId: auditRow.id,
});
ok('upsertPage stores the full Phase 2 field set', typeof pageId3 === 'number');
const fullPage = (await store.getPage(pageId3));
ok('getPage round-trips the extended fields with correct types', fullPage.h1_count === 1 && fullPage.word_count === 500 && fullPage.json_ld_present === true && fullPage.depth === 1);

await store.createLinks(w1.id, auditRow.id, [
  { fromPageId: pageId, toUrl: 'https://hkdevlab.com/services', toPageId: pageId3, anchorText: 'Our services', isInternal: true },
  { fromPageId: pageId, toUrl: 'https://external.example/x', toPageId: null, anchorText: 'External', isInternal: false },
]);
ok('createLinks does not throw and accepts a null to_page_id for an external link', true);

const audit2 = await store.createAudit(w1.id, { baseUrl: 'https://hkdevlab.com', pagesPlanned: 100 });
await store.finishAudit(audit2.id, { score: 95, status: 'complete', summary: 'ok', pagesCrawled: 2, errorsCount: 0, durationMs: 500, pagespeed: { available: true, performanceScore: 88 } });
ok('finishAudit stores the Phase 2 crawl stats and a JSON pagespeed result', (await store.getAudit(audit2.id)).pages_crawled === 2 && (await store.getAudit(audit2.id)).pagespeed.performanceScore === 88);
ok('previousCompleteAudit finds the earlier complete audit, excluding the current one', (await store.previousCompleteAudit(w1.id, audit2.id)).id === auditRow.id);
ok('listAudits returns newest first', (await store.listAudits(w1.id))[0].id === audit2.id);

// Phase 2.1: async job queue primitives — a separate website row, so these don't disturb w1's audit id ordering above
const w3 = await store.ensureWebsite('async-jobs-test.example', 'Async Jobs Test');
const queuedRow = await store.createAudit(w3.id, { baseUrl: 'https://async-jobs-test.example', status: 'queued' });
ok('createAudit(status: "queued") starts queued, not running', queuedRow.status === 'queued');
ok('activeAudit finds the queued audit', (await store.activeAudit(w3.id))?.id === queuedRow.id);
ok('claimAudit moves queued -> running and reports success', (await store.claimAudit(queuedRow.id)) === true && (await store.getAudit(queuedRow.id)).status === 'running');
ok('claimAudit on an already-running audit fails (loses the race)', (await store.claimAudit(queuedRow.id)) === false);
ok('claimAudit on a nonexistent audit fails', (await store.claimAudit(999999)) === false);
await store.finishAudit(queuedRow.id, { score: 100, status: 'complete', summary: 'ok', pagesCrawled: 1, errorsCount: 0, durationMs: 5 });
ok('activeAudit is empty again once the audit is complete', (await store.activeAudit(w3.id)) == null);

// createAuditIfNoneActive: the atomic duplicate-scan guard POST /scan relies on (closes the TOCTOU race a
// separate activeAudit()-then-createAudit() would have between two near-simultaneous requests)
const atomic1 = await store.createAuditIfNoneActive(w3.id, { baseUrl: 'https://async-jobs-test.example', pagesPlanned: 50 });
ok('createAuditIfNoneActive succeeds when nothing is active', atomic1 && atomic1.status === 'queued');
const atomic2 = await store.createAuditIfNoneActive(w3.id, { baseUrl: 'https://async-jobs-test.example', pagesPlanned: 50 });
ok('…and returns null (inserts nothing) while that one is still queued/running', atomic2 === null);
const [concA, concB] = await Promise.all([
  store.createAuditIfNoneActive(w3.id, {}), store.createAuditIfNoneActive(w3.id, {}),
]);
ok('two concurrent calls racing the same website: exactly one still wins, never both', [concA, concB].filter(Boolean).length === 0);   // both blocked — atomic1 is still active
await store.finishAudit(atomic1.id, { status: 'failed', summary: 'test cleanup' });
const atomic3 = await store.createAuditIfNoneActive(w3.id, {});
ok('…and succeeds again once the earlier one is no longer active', atomic3 && atomic3.status === 'queued');
await store.finishAudit(atomic3.id, { status: 'failed', summary: 'test cleanup' });

const rec = await store.createRecommendation({ websiteId: w1.id, issueId: allIssues[0].id, pageId: pageId3, type: 'title', currentValue: 'Old', proposedValue: 'New', reasoning: 'because', aiProvider: 'anthropic', aiModel: 'claude-sonnet-5' });
ok('createRecommendation starts pending', rec.status === 'pending' && typeof rec.id === 'number');
ok('listRecommendations finds it', (await store.listRecommendations({ websiteId: w1.id })).some((r) => r.id === rec.id));
const approved = await store.setRecommendationStatus(rec.id, 'approved', { reviewedBy: 'admin@x.co' });
ok('setRecommendationStatus records the reviewer and timestamp', approved.status === 'approved' && approved.reviewed_by === 'admin@x.co' && !!approved.reviewed_at);
const applied = await store.setRecommendationStatus(rec.id, 'applied', { applied: true });
ok('…and the applied timestamp on a later call', applied.status === 'applied' && !!applied.applied_at);

// cleanup
ok('deleteUser', (await store.deleteUser(uid)) === true && (await store.userCount()) === 0);
ok('remove enquiry', (await store.remove(id)) === true && (await store.list()).length === 0);
await store.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
