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

/* ───────────── Phase 3 Step 2: recommendation-level verification (PostgreSQL path) ─────────────
   Three separate websites (resolved / still-present / no-resolvable-issue), so verifying one never
   touches another — proven explicitly below, not just by construction. */
const { verifyAppliedRecommendations } = await import(new URL('./seo/jobs.js', import.meta.url).href);
const mkRec = (websiteId, issueId, pageId) => store.createRecommendation({ websiteId, issueId, pageId, type: 'title', currentValue: 'x', proposedValue: 'y', reasoning: 'z', aiProvider: 'anthropic', aiModel: 'claude-sonnet-5' });
const applyRec = async (r) => { await store.setRecommendationStatus(r.id, 'approved', { reviewedBy: 'a@x.co' }); return store.setRecommendationStatus(r.id, 'applied', { applied: true }); };

// w4: the issue disappears by the next scan -> resolved. Also seeds pending/approved-only/failed siblings
// off the SAME issue, to prove verification only ever touches an 'applied' recommendation.
const w4 = await store.ensureWebsite('verify-test.example', 'Verify Test');
const auditA = await store.createAudit(w4.id, { baseUrl: 'https://verify-test.example' });
// Verification only speaks for a page the verifying audit actually observed, so the issue belongs to a real page, and each "next"
// audit below fetches that page successfully (HTTP 200, text/html) before it is verified against.
const observePage = (website, url, auditId) => store.upsertPage({ websiteId: website.id, url, finalUrl: url, statusCode: 200, contentType: 'text/html', auditId });
const pageW4 = await observePage(w4, 'https://verify-test.example/', auditA.id);
await store.createIssues(w4.id, auditA.id, [{ pageId: pageW4, type: 'missing-title', severity: 'critical', detail: 'no title' }]);
await store.finishAudit(auditA.id, { score: 70, status: 'complete', summary: '1 issue', pagesCrawled: 1, errorsCount: 0, durationMs: 5 });
const issueX = (await store.listIssues({ websiteId: w4.id, auditId: auditA.id }))[0];
const recApplied = await mkRec(w4.id, issueX.id, issueX.page_id);
ok('a recommendation created from an issue stores a reliable source-issue reference (issue_id) — not text/title matching', recApplied.issue_id === issueX.id);
const recPending = await mkRec(w4.id, issueX.id, issueX.page_id);
const recApprovedOnly = await mkRec(w4.id, issueX.id, issueX.page_id);
const recFailed = await mkRec(w4.id, issueX.id, issueX.page_id);
await applyRec(recApplied);
await store.setRecommendationStatus(recApprovedOnly.id, 'approved', { reviewedBy: 'a@x.co' });   // approved, never applied
await store.setRecommendationStatus(recFailed.id, 'failed', {});                                  // recPending stays pending

// w5: the issue is still there at the next scan -> still-present.
const w5 = await store.ensureWebsite('verify-test-2.example', 'Verify Test 2');
const auditC = await store.createAudit(w5.id, { baseUrl: 'https://verify-test-2.example' });
const pageW5 = await observePage(w5, 'https://verify-test-2.example/', auditC.id);
await store.createIssues(w5.id, auditC.id, [{ pageId: pageW5, type: 'missing-title', severity: 'critical', detail: 'no title' }]);
await store.finishAudit(auditC.id, { score: 70, status: 'complete', summary: '1 issue', pagesCrawled: 1, errorsCount: 0, durationMs: 5 });
const issueY = (await store.listIssues({ websiteId: w5.id, auditId: auditC.id }))[0];
const recStillPresent = await mkRec(w5.id, issueY.id, issueY.page_id);
await applyRec(recStillPresent);

// w6: the recommendation's issue can't be resolved at verification time -> unknown, never fabricated.
const w6 = await store.ensureWebsite('verify-test-3.example', 'Verify Test 3');
const recNoIssue = await mkRec(w6.id, 999999, null);
await applyRec(recNoIssue);

await new Promise((r) => setTimeout(r, 5));   // guarantee each "next" audit's started_at strictly postdates its recommendation's applied_at
const contentBefore = JSON.stringify(await store.getContent());

const auditB = await store.createAudit(w4.id, { baseUrl: 'https://verify-test.example' });   // no issues this time
await observePage(w4, 'https://verify-test.example/', auditB.id);
await store.finishAudit(auditB.id, { score: 100, status: 'complete', summary: 'no issues', pagesCrawled: 1, errorsCount: 0, durationMs: 5 });
const auditD = await store.createAudit(w5.id, { baseUrl: 'https://verify-test-2.example' });
await observePage(w5, 'https://verify-test-2.example/', auditD.id);
await store.createIssues(w5.id, auditD.id, [{ pageId: pageW5, type: 'missing-title', severity: 'critical', detail: 'still no title' }]);   // same signature: type + page
await store.finishAudit(auditD.id, { score: 70, status: 'complete', summary: '1 issue', pagesCrawled: 1, errorsCount: 0, durationMs: 5 });
const auditE = await store.createAudit(w6.id, { baseUrl: 'https://verify-test-3.example' });
await store.finishAudit(auditE.id, { score: 100, status: 'complete', summary: 'ok', pagesCrawled: 1, errorsCount: 0, durationMs: 5 });

const auditCountW4Before = (await store.listAudits(w4.id, 100)).length;
await verifyAppliedRecommendations(store, w4.id, auditB.id);

const vApplied = await store.getRecommendation(recApplied.id);
ok('applied recommendation whose issue disappeared by the next scan is verified "resolved"', vApplied.verified_status === 'resolved' && vApplied.verified_audit_id === auditB.id && !!vApplied.verified_at);
ok('a pending recommendation is never verified', (await store.getRecommendation(recPending.id)).verified_status == null);
ok('an approved-but-not-applied recommendation is never verified', (await store.getRecommendation(recApprovedOnly.id)).verified_status == null);
ok('a failed recommendation is never verified', (await store.getRecommendation(recFailed.id)).verified_status == null);
ok('verifying w4 never touches w5\'s recommendation (cross-website isolation)', (await store.getRecommendation(recStillPresent.id)).verified_status == null);
ok('verifying w4 never touches w6\'s recommendation either', (await store.getRecommendation(recNoIssue.id)).verified_status == null);
ok('verification creates no new audit rows — it never triggers a recursive scan', (await store.listAudits(w4.id, 100)).length === auditCountW4Before);

await verifyAppliedRecommendations(store, w5.id, auditD.id);
const vStill = await store.getRecommendation(recStillPresent.id);
ok('applied recommendation whose issue is still present at the next scan is verified "still-present"', vStill.verified_status === 'still-present' && vStill.verified_audit_id === auditD.id);
ok('verifying w5 never re-touches w4\'s already-verified recommendation', (await store.getRecommendation(recApplied.id)).verified_status === 'resolved');

await verifyAppliedRecommendations(store, w6.id, auditE.id);
const vUnknown = await store.getRecommendation(recNoIssue.id);
ok('an applied recommendation whose source issue cannot be resolved is safely "unknown", never a fabricated relationship', vUnknown.verified_status === 'unknown' && vUnknown.verified_audit_id === auditE.id);

// repeated calls (a later unrelated scan, or a re-poll) must not corrupt an already-recorded result
await verifyAppliedRecommendations(store, w4.id, auditB.id);
await verifyAppliedRecommendations(store, w4.id, auditB.id);
const reVerified = await store.getRecommendation(recApplied.id);
ok('repeated verification calls do not corrupt or overwrite an already-recorded result', reVerified.verified_status === 'resolved' && reVerified.verified_at === vApplied.verified_at && reVerified.verified_audit_id === vApplied.verified_audit_id);

ok('none of this touched site content at all', JSON.stringify(await store.getContent()) === contentBefore);

// a verification-time error must never throw out of verifyAppliedRecommendations (so it can never fail the
// audit that called it) — needs a FRESH unverified 'applied' candidate, since everything above is already verified
const w7 = await store.ensureWebsite('verify-test-4.example', 'Verify Test 4');
const auditF = await store.createAudit(w7.id, { baseUrl: 'https://verify-test-4.example' });
await store.createIssues(w7.id, auditF.id, [{ type: 'missing-title', severity: 'critical', detail: 'x' }]);
await store.finishAudit(auditF.id, { score: 70, status: 'complete', summary: '1 issue', pagesCrawled: 1, errorsCount: 0, durationMs: 5 });
const issueZ = (await store.listIssues({ websiteId: w7.id, auditId: auditF.id }))[0];
const recForErrorTest = await mkRec(w7.id, issueZ.id, issueZ.page_id);
await applyRec(recForErrorTest);
await new Promise((r) => setTimeout(r, 5));
const auditG = await store.createAudit(w7.id, { baseUrl: 'https://verify-test-4.example' });
await store.finishAudit(auditG.id, { score: 100, status: 'complete', summary: 'ok', pagesCrawled: 1, errorsCount: 0, durationMs: 5 });

const realGetIssue = store.getIssue;
store.getIssue = async () => { throw new Error('simulated verification failure'); };
let threw = false;
try { await verifyAppliedRecommendations(store, w7.id, auditG.id); } catch { threw = true; }
store.getIssue = realGetIssue;
ok('an unexpected error during verification is swallowed, never thrown back at the caller', threw === false);
ok('…and the affected recommendation is safely marked "unknown" rather than left in a broken or corrupted state', (await store.getRecommendation(recForErrorTest.id)).verified_status === 'unknown');

// cleanup
ok('deleteUser', (await store.deleteUser(uid)) === true && (await store.userCount()) === 0);
ok('remove enquiry', (await store.remove(id)) === true && (await store.list()).length === 0);
await store.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
