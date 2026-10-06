import { crawlWebsite } from './crawler.js';
import { analyzePages } from './pageAnalyzer.js';
import { scoreFromIssues } from './analyzers.js';   // Phase 1's pure severity-weighted scorer — unchanged, reused as-is
import { crawlLimits, staleAuditMs } from './limits.js';
import { fetchPageSpeed } from './pagespeed.js';
import { runOnPageSpecialistIntegration } from './specialistIntegration.js';

/**
 * ASYNC SCAN JOBS (Phase 2.1). WEBSITE → REAL CRAWLER → PAGE DISCOVERY → HTML EXTRACTION →
 * TECHNICAL/ON-PAGE/LINK ANALYSIS → SEO ISSUES, running as a DB-backed job instead of inline in the HTTP
 * request: queueScan() only writes a 'queued' seo_audits row and returns — the crawl itself runs in
 * executeScan(), kicked off in the background so POST /scan responds immediately.
 *
 * There is no external queue (no Redis) and no assumption that a background timer survives the request:
 * this codebase also runs as a Vercel serverless function, which can freeze the moment a response is sent
 * (see the contact-form mailer's comment in server/app.js) — a bare `setImmediate` kick can lose that race.
 * So progress is guaranteed two ways, and claimAudit() (an atomic 'queued'→'running' compare-and-swap in
 * server/db.js) makes it safe for both to race on the same audit:
 *   1. queueScan() fires the crawl in the background (setImmediate) — normally wins on a long-running server.
 *   2. Every poll route calls ensureProgressing(): if an audit is STILL 'queued' when someone asks about it,
 *      it runs the crawl right there, inline, before answering. On serverless this is what actually finishes
 *      the job — the first poll after POST /scan does the real work. Once a scan is 'running' or done,
 *      ensureProgressing() is a cheap no-op read.
 */
export const STALE_AUDIT_SUMMARY = 'Marked failed by stale-audit recovery: this scan never recorded a completion, so it was presumed interrupted (restart, timeout or crash).';

/** An audit stuck 'queued'/'running' (the process died or was killed before finishing it) would otherwise block
 *  every later scan of its website forever. Fails this website's audits older than the stale threshold in one
 *  atomic UPDATE. Never throws: if the sweep itself fails, the normal active-audit check still runs unchanged. */
async function recoverStaleAudits(store, websiteId) {
  try {
    const cutoff = new Date(Date.now() - staleAuditMs()).toISOString();
    const recovered = await store.failStaleAudits(websiteId, { cutoff, summary: STALE_AUDIT_SUMMARY });
    if (recovered > 0) console.error(`[seo] recovered ${recovered} stale audit(s) for website #${websiteId} (queued/running past the stale threshold)`);
  } catch (err) {
    console.error('[seo] stale-audit recovery failed — continuing with the normal active-audit check:', err.message);
  }
}

/** Returns the newly queued audit, or null if one was already queued/running for this website — see
 *  createAuditIfNoneActive() in server/db.js, an atomic INSERT…WHERE NOT EXISTS that closes the race a plain
 *  "check, then insert" would have between two near-simultaneous POST /scan requests. Stale audits are
 *  recovered first so a dead one can't be the "already running" scan that blocks a new one. */
export async function queueScan(store, website, { baseUrl } = {}) {
  const limits = crawlLimits();
  await recoverStaleAudits(store, website.id);
  const audit = await store.createAuditIfNoneActive(website.id, { baseUrl, pagesPlanned: limits.maxPages });
  if (!audit) return null;
  setImmediate(() => {
    executeScan(store, website.id, audit.id, baseUrl).catch((err) => console.error('[seo] background scan failed:', err.message));
  });
  return audit;
}

/** Why this crawl never actually observed its starting page — or null when it did. The start page is always pages[0] (crawler.js
 *  queues it first, and the analyzer takes its startUrl from there too). It counts as observed when the analyzer can represent it:
 *  a fetched HTML page whatever its HTTP status (a 404/503 HTML page becomes an ordinary broken-page issue), or a page robots.txt
 *  excludes (reported as a critical robots-disallow issue). Anything else — no response at all (refused, DNS, timeout, oversized
 *  body) or a response that is not HTML — leaves the analyzer nothing to analyze: every page-level issue would simply vanish, and a
 *  "complete" audit with a score would claim a clean bill of health nobody checked. */
const startPageProblem = (crawl) => {
  const start = crawl.pages[0];
  if (!start) return 'the crawl recorded no pages';
  if (start.disallowedByRobots) return null;
  if (start.error) return String(start.error).slice(0, 200);
  if (start.statusCode == null) return 'no response was received';
  if (!/text\/html/i.test(start.contentType || '')) return `it is not an HTML page — HTTP ${start.statusCode}, ${String(start.contentType || 'no content type').slice(0, 80)}`;
  return null;
};

/** Runs one already-created audit's crawl to completion (or failure). Safe to call more than once for the
 *  same audit id — claimAudit() ensures only the first caller to reach 'queued' actually does the work. */
export async function executeScan(store, websiteId, auditId, baseUrl) {
  if (!(await store.claimAudit(auditId))) return;   // already running/complete/failed, or claimed by the other caller — nothing to do

  const limits = crawlLimits();
  const startedAt = Date.now();
  try {
    const crawl = await crawlWebsite(baseUrl, limits);

    // Ownership: the crawl can take minutes, and stale recovery may have failed this audit while it ran (a newer audit may already be
    // writing). A worker that no longer owns its audit stops here and records nothing. This is NOT the correctness boundary — the
    // check cannot close the window between it and the writes below — which is why upsertPage() refuses, in SQL, to overwrite a page
    // a newer audit already owns; this just keeps an audit that is already over from producing more rows.
    const owned = await store.getAudit(auditId);
    if (!owned || owned.status !== 'running') {
      console.error(`[seo] audit #${auditId} was already recovered as stale before this scan could record its crawl (status: ${owned?.status ?? 'missing'}) — writing nothing and skipping all post-audit work`);
      return;
    }

    // Audit honesty: if the start page was never observed there is nothing true to report. Fail the scan through the catch below — the
    // one existing failure path (no score, no new status, guarded by finishAudit()) — carrying the crawl's real counts, and record
    // NOTHING from this crawl: no page, link or issue rows, so the previous audit's data and the comparison baseline stay as they were.
    const unobserved = startPageProblem(crawl);
    if (unobserved) {
      throw Object.assign(
        new Error(`The start page ${crawl.pages[0]?.url || baseUrl} could not be observed (${unobserved}), so no results were recorded for this scan`),
        { pagesCrawled: crawl.pages.length, errorsCount: crawl.errors.length });
    }

    const issues = analyzePages(crawl);

    const urlToPageId = new Map();
    for (const p of crawl.pages) {
      if (p.disallowedByRobots) continue;
      const id = await store.upsertPage({
        websiteId, url: p.url, finalUrl: p.finalUrl, statusCode: p.statusCode, contentType: p.contentType,
        title: p.title, description: p.description, canonical: p.canonical, robots: p.robotsMeta,
        h1Count: p.h1Count, h2Count: p.h2Count, wordCount: p.wordCount, htmlSize: p.htmlSize, responseTimeMs: p.responseTimeMs,
        depth: p.depth, imageCount: p.images?.length, imagesMissingAlt: p.missingAltCount, lang: p.lang,
        ogTitle: p.ogTitle, ogDescription: p.ogDescription, ogImage: p.ogImage, twitterCard: p.twitterCard,
        jsonLdPresent: p.jsonLdPresent, auditId,
      });
      urlToPageId.set(p.url, id);
    }

    const links = crawl.links.map((l) => ({ ...l, fromPageId: urlToPageId.get(l.fromUrl), toPageId: urlToPageId.get(l.toUrl) })).filter((l) => l.fromPageId);
    if (links.length) await store.createLinks(websiteId, auditId, links);

    const issuesWithPageIds = issues.map((it) => ({ ...it, pageId: it.pageUrl ? urlToPageId.get(it.pageUrl) ?? null : null }));
    if (issuesWithPageIds.length) await store.createIssues(websiteId, auditId, issuesWithPageIds);

    // best-effort, never blocks or fails the scan — see server/seo/pagespeed.js
    const pagespeed = await fetchPageSpeed(crawl.pages[0]?.finalUrl || baseUrl, { timeoutMs: limits.requestTimeoutMs * 1.5 }).catch(() => ({ available: false, reason: 'request failed' }));

    // Phase 3 Step 4P-E: the one approved, audit-level performance issue. This MUST run here, after
    // fetchPageSpeed() resolves — analyzePages()/createIssues() above already ran before PageSpeed existed,
    // so this is a second, separate createIssues() call, not an addition to issuesWithPageIds. The threshold
    // (<50) lives here, at the issue-production layer, per the existing project principle that an analyzer
    // (not a specialist agent) decides what counts as a problem — see server/seo/performanceAgent.js, which
    // only ever consumes this already-decided Issue and never recalculates the threshold itself. pageId is
    // null because PageSpeed measured exactly one URL for the whole audit, never a specific crawled page —
    // never pretend this single score represents every page on the site.
    if (pagespeed?.available === true && typeof pagespeed.performanceScore === 'number' && pagespeed.performanceScore < 50) {
      await store.createIssues(websiteId, auditId, [
        { pageId: null, type: 'performance-score-low', severity: 'warning', detail: `${baseUrl} scored ${pagespeed.performanceScore}/100 on Google PageSpeed Insights (mobile, lab data).` },
      ]);
    }

    const score = scoreFromIssues(issues);
    const finished = await store.finishAudit(auditId, {
      score, status: 'complete', summary: `${crawl.pages.length} page(s) crawled, ${issues.length} issue(s) found.`,
      pagesCrawled: crawl.pages.length, errorsCount: crawl.errors.length, durationMs: Date.now() - startedAt, pagespeed,
    });
    if (!finished) {
      // Stale recovery already failed this audit while this worker was still crawling: it no longer owns the
      // audit, so its result is discarded and none of the post-audit work below may run against it.
      console.error(`[seo] audit #${auditId} was already recovered as stale before this scan finished — discarding its result and skipping all post-audit work`);
      return;
    }
    // The audit is already committed as 'complete' above — nothing past this point can affect that outcome.
    // verifyAppliedRecommendations() never throws (it catches internally); this .catch() is belt-and-suspenders.
    await verifyAppliedRecommendations(store, websiteId, auditId).catch((err) => console.error('[seo] recommendation verification failed:', err.message));
    // Phase 3 Step 4K: the On-Page specialist agent is the only one wired in so far (see
    // server/seo/specialistIntegration.js) — same belt-and-suspenders .catch(), same rule: a specialist-layer
    // problem can never affect an otherwise-successful audit.
    const diagnostics = await runOnPageSpecialistIntegration(store, websiteId, auditId)
      .catch((err) => { console.error('[seo] on-page specialist integration failed:', err.message); return null; });
    // Phase 3 Step 4W.2: persist the already-computed conflicts/skipped/errors for observability only — this
    // audit was already committed 'complete' above, and this write can never affect that outcome. `diagnostics`
    // is only null if the belt-and-suspenders .catch() just above fired — the specialist integration function
    // itself already returns its own empty-shape fallback on every one of its handled failure paths.
    if (diagnostics) {
      await store.setSpecialistDiagnostics(auditId, diagnostics).catch((err) => console.error('[seo] persisting specialist diagnostics failed:', err.message));
    }
  } catch (err) {
    const recorded = await store.finishAudit(auditId, { score: null, status: 'failed', summary: String(err.message || err), pagesCrawled: err?.pagesCrawled, errorsCount: err?.errorsCount, durationMs: Date.now() - startedAt });
    if (!recorded) console.error(`[seo] audit #${auditId} failed (${String(err.message || err).slice(0, 200)}) but had already been moved out of queued/running — leaving it as it is`);
  }
}

/** Poll-time safety net (see the module comment above). A cheap no-op unless the audit is still 'queued'. */
export async function ensureProgressing(store, audit) {
  if (!audit || audit.status !== 'queued') return audit;
  await executeScan(store, audit.website_id, audit.id, audit.base_url);
  return store.getAudit(audit.id);
}

/** The one issue-identity signature used everywhere two audits' issues need to be compared: same type on the
 *  same page (or sitewide, when page is null) counts as "the same issue" across scans. Shared by
 *  compareToPreviousAudit() (audit-level before/after) and verifyAppliedRecommendations() below
 *  (recommendation-level verification) — deliberately one function, not two incompatible ones. */
const issueKey = (i) => `${i.type}:${i.page_id ?? ''}`;

/** BEFORE vs AFTER: buckets the previous complete audit's issues against this one's by (type, page), so a
 *  re-scan can honestly report resolved/introduced/unchanged counts — never a claimed improvement that
 *  isn't backed by the analyzer actually finding fewer issues.
 *
 *  An issue that is no longer reported only counts as RESOLVED when this audit really looked at its page (observedByAudit, the same
 *  test verification uses); a page the audit never reached, or that failed or was not a successful HTML response, tells us nothing
 *  about its old issues, so they are reported as `notRecheckedCount` instead — neither resolved nor still present. Only issues that
 *  belong to a page are filtered: page-less (site-wide) issues keep their ordinary semantics, and `unchanged`/`introduced` are
 *  never touched (an issue that IS reported again was, by definition, found by this audit).
 *
 *  The pages table keeps one row per page — the facts from its most recent crawl — so this is exact for the audit that crawled last
 *  (the one just finished, which is when it is read) and conservative for an older one: its pages no longer say what it saw, so they
 *  are not counted as resolved rather than guessed. */
export async function compareToPreviousAudit(store, websiteId, currentAuditId) {
  const previous = await store.previousCompleteAudit(websiteId, currentAuditId);
  if (!previous) return null;
  const [prevIssues, currIssues, pages] = await Promise.all([
    store.listIssues({ websiteId, auditId: previous.id, limit: 2000 }),
    store.listIssues({ websiteId, auditId: currentAuditId, limit: 2000 }),
    store.listPages(websiteId),
  ]);
  const pageById = new Map(pages.map((p) => [p.id, p]));
  const prevKeys = new Set(prevIssues.map(issueKey));
  const currKeys = new Set(currIssues.map(issueKey));
  const notRechecked = new Set(prevIssues
    .filter((i) => i.page_id != null && !currKeys.has(issueKey(i)) && !observedByAudit(pageById.get(i.page_id), websiteId, currentAuditId))
    .map(issueKey));
  return {
    previousAuditId: previous.id,
    resolvedCount: [...prevKeys].filter((k) => !currKeys.has(k) && !notRechecked.has(k)).length,
    introducedCount: [...currKeys].filter((k) => !prevKeys.has(k)).length,
    unchangedCount: [...currKeys].filter((k) => prevKeys.has(k)).length,
    notRecheckedCount: notRechecked.size,
  };
}

/**
 * PHASE 3 STEP 2 — RECOMMENDATION-LEVEL VERIFICATION.
 * SEO ISSUE → AI RECOMMENDATION → HUMAN APPROVAL → SAFE APPLY → APPLIED → (here, after the next completed
 * scan) → VERIFY ORIGINAL ISSUE → resolved / still-present / unknown.
 *
 * Read/analysis only: this function only ever calls store *read* methods plus the one narrow write
 * (setRecommendationVerification, which touches nothing but verified_status/verified_at/verified_audit_id on
 * one row). It never imports llm.js, recommendations.js, apply.js, or crawler.js — structurally, it cannot
 * generate a recommendation, apply anything, modify content, change a recommendation's lifecycle `status`,
 * or trigger another crawl. It never throws: any failure here must never be able to mark an otherwise-
 * successful scan as failed, so every error is caught and logged (never with secrets — only err.message).
 *
 * `issue_id` (NOT NULL since Phase 2) is already the reliable link from a recommendation to the issue that
 * produced it — no separate "source issue" column was needed. Issue identity across audits reuses issueKey()
 * above, the exact same signature compareToPreviousAudit() already uses, per the existing convention.
 *
 * OBSERVATION REQUIREMENT. An issue being absent from an audit only means "fixed" if that audit actually LOOKED at the
 * page: the analyzer reports nothing for a page that was never fetched, timed out, answered with an error, was excluded
 * by robots.txt, was no longer linked, or was cut off by the page limit. So a verdict (resolved / still-present) is only
 * ever written when the recommendation's target page was fetched successfully, as HTML, BY THIS VERY AUDIT (see
 * observedByAudit). Otherwise nothing is written at all — no verdict, no verified_audit_id, not even 'unknown' (which is
 * final) — and the recommendation stays unverified, so a later audit that does observe the page can still verify it.
 */

/** Was `page` fetched successfully, as an HTML page, by audit `auditId`? Uses only what the crawl already records:
 *  pages.last_audit_id (which audit last crawled it), status_code (null for a failed fetch) and content_type — the same
 *  "successful HTML page" test the analyzer applies (HTTP 2xx, text/html). A page row that merely exists, belongs to an
 *  older audit, or recorded an error / non-2xx / non-HTML response does not count. */
const observedByAudit = (page, websiteId, auditId) => !!page
  && page.website_id === websiteId
  && page.last_audit_id === auditId
  && Number.isInteger(page.status_code) && page.status_code >= 200 && page.status_code < 300
  && /text\/html/i.test(page.content_type || '');

export async function verifyAppliedRecommendations(store, websiteId, auditId) {
  let candidates, currentIssues, audit;
  try {
    [candidates, currentIssues, audit] = await Promise.all([
      store.listUnverifiedApplied(websiteId),
      store.listIssues({ websiteId, auditId, limit: 5000 }),
      store.getAudit(auditId),
    ]);
  } catch (err) {
    console.error('[seo] could not load data for recommendation verification — leaving it for a later scan:', err.message);
    return;
  }
  if (!candidates.length || !audit) return;
  const currentKeys = new Set(currentIssues.map(issueKey));

  for (const rec of candidates) {
    if (rec.website_id !== websiteId) continue;   // defensive: a recommendation is never verified against a website it doesn't belong to
    try {
      // The crawl behind THIS audit must have started after the fix went live, or it can't possibly reflect
      // it — skip rather than guess, leaving the recommendation unverified for a later scan to check honestly.
      if (!rec.applied_at || !audit.started_at || !(new Date(audit.started_at) > new Date(rec.applied_at))) continue;

      const issue = await store.getIssue(rec.issue_id);
      if (!issue || issue.website_id !== websiteId) {
        // no resolvable source issue (deleted, or — for a pre-verification recommendation in a hypothetical
        // future where issue_id could be absent — never invent a relationship): honestly unknown.
        await store.setRecommendationVerification(rec.id, { verifiedStatus: 'unknown', verifiedAuditId: auditId });
        continue;
      }

      // The observation requirement (see above): no verdict unless this audit actually fetched the target page as HTML.
      // A recommendation without a page, a page that can't be read, or one this audit did not observe successfully is
      // SKIPPED — a genuine "not yet", not a verdict — and stays eligible for a later audit.
      let target = null;
      if (rec.page_id != null) {
        try { target = await store.getPage(rec.page_id); }
        catch (err) { console.error(`[seo] could not read the target page of recommendation #${rec.id} — leaving it unverified:`, err.message); }
      }
      if (!observedByAudit(target, websiteId, auditId)) continue;

      const stillPresent = currentKeys.has(issueKey(issue));
      await store.setRecommendationVerification(rec.id, { verifiedStatus: stillPresent ? 'still-present' : 'resolved', verifiedAuditId: auditId });
    } catch (err) {
      console.error(`[seo] verification of recommendation #${rec.id} failed, recording 'unknown':`, err.message);
      try { await store.setRecommendationVerification(rec.id, { verifiedStatus: 'unknown', verifiedAuditId: auditId }); } catch { /* best effort — leave it for a later scan */ }
    }
  }
}
