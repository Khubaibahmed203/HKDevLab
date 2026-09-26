import express from 'express';
import { siteOrigin } from '../../content/seo.js';
import { runScan } from './jobs.js';
import { generateRecommendation } from './recommendations.js';
import { applyRecommendation } from './apply.js';

const SEVERITIES = ['critical', 'warning', 'info'];
const REC_STATUSES = ['pending', 'approved', 'rejected', 'applied', 'failed'];

/**
 * /api/admin/seo/* — mounted under the SAME admin router as everything else in server/app.js, so every
 * route here inherits auth.requireUser, the JSON body parser, auth.csrf, and the no-store/no-index headers
 * already applied there. No second auth system, no separate rate-limit mechanism.
 *
 * Not hardcoded to hkdevlab.com: the domain is read from PUBLIC_URL (falling back to the production
 * default) and resolved to a `websites` row at request time — a second site later is just another row.
 *
 * The pipeline this router exposes: CRAWLER → ANALYZER → SEO ISSUES (all inside POST /scan) → LLM
 * recommendation (POST /issues/:id/recommend) → HUMAN APPROVAL (approve/reject) → SAFE APPLY (apply) →
 * RE-SCAN (POST /scan again — its response's `comparison` field says what changed). Nothing here ever
 * writes to production content except an explicitly approved recommendation, applied by an explicit call.
 */
export function createSeoRouter(store, { limiter }) {
  const router = express.Router();
  const asyncH = (fn) => (req, res, next) => fn(req, res, next).catch(next);

  const origin = () => siteOrigin(process.env.PUBLIC_URL);
  const homeWebsite = () => store.ensureWebsite(new URL(origin()).host, 'HK DevLab');

  /* ───────────── scans ───────────── */
  router.post('/scan', asyncH(async (req, res) => {
    if (await limiter.take(`seo-scan:${req.user.id}`, 10, 10 * 60_000)) {
      return res.status(429).json({ ok: false, error: 'Too many audits started — please wait a few minutes.' });
    }
    const website = await homeWebsite();
    const requestedBase = typeof req.body?.baseUrl === 'string' ? req.body.baseUrl : undefined;
    // an admin may point a scan at a staging URL, but it must still resolve to THIS website's own host —
    // otherwise this endpoint would let an admin use the server as a crawler against arbitrary domains
    let baseUrl = origin();
    if (requestedBase) {
      let reqHost; try { reqHost = new URL(requestedBase).host; } catch { return res.status(400).json({ ok: false, error: 'baseUrl is not a valid URL.' }); }
      if (reqHost !== new URL(origin()).host) return res.status(400).json({ ok: false, error: `baseUrl must be on ${new URL(origin()).host}.` });
      baseUrl = requestedBase;
    }
    const audit = await runScan(store, website, { baseUrl });
    res.status(201).json({ ok: true, audit });
  }));

  router.get('/scans', asyncH(async (req, res) => {
    const website = await homeWebsite();
    res.json({ audits: await store.listAudits(website.id, Math.min(+req.query.limit || 20, 100)) });
  }));

  // must come before /scans/:id, or Express would try to parse "latest" as a numeric audit id
  router.get('/scans/latest', asyncH(async (req, res) => {
    const website = await homeWebsite();
    res.json({ audit: await store.latestAudit(website.id) });
  }));

  router.get('/scans/:id', asyncH(async (req, res) => {
    const found = await store.getAudit(+req.params.id);
    if (!found) return res.status(404).json({ ok: false, error: 'Audit not found.' });
    res.json({ audit: found });
  }));

  /* ───────────── pages ───────────── */
  router.get('/pages', asyncH(async (req, res) => {
    const website = await homeWebsite();
    res.json({ pages: await store.listPages(website.id) });
  }));

  /* ───────────── issues ───────────── */
  router.get('/issues', asyncH(async (req, res) => {
    const website = await homeWebsite();
    const { auditId, severity, status, type, pageId } = req.query;
    const filters = {
      websiteId: website.id,
      auditId: auditId ? +auditId : undefined,
      severity: SEVERITIES.includes(severity) ? severity : undefined,
      status: typeof status === 'string' && status ? status : undefined,
      type: typeof type === 'string' && type ? type : undefined,
      pageId: pageId ? +pageId : undefined,
      limit: Math.min(+req.query.limit || 100, 500),
      offset: +req.query.offset || 0,
    };
    const [issues, latest] = await Promise.all([store.listIssues(filters), store.latestAudit(website.id)]);
    const counts = filters.auditId ? await store.issueCountsBySeverity(filters.auditId) : latest ? await store.issueCountsBySeverity(latest.id) : { total: 0, critical: 0, warning: 0, info: 0 };
    res.json({ issues, counts });
  }));

  /* ───────────── AI recommendations (LLM never crawls, never writes — see recommendations.js) ───────────── */
  router.post('/issues/:id/recommend', asyncH(async (req, res) => {
    if (await limiter.take(`seo-recommend:${req.user.id}`, 20, 10 * 60_000)) {
      return res.status(429).json({ ok: false, error: 'Too many recommendation requests — please wait a few minutes.' });
    }
    const issue = await store.getIssue(+req.params.id);
    if (!issue) return res.status(404).json({ ok: false, error: 'Issue not found.' });
    const page = issue.page_id ? await store.getPage(issue.page_id) : null;

    const result = await generateRecommendation({ issue, page });
    if (!result.ok) {
      const status = result.error === 'unavailable' ? 503 : 502;
      return res.status(status).json({ ok: false, error: result.error === 'unavailable' ? 'No AI provider is configured (set ANTHROPIC_API_KEY).' : result.error });
    }
    const rec = await store.createRecommendation({
      websiteId: issue.website_id, issueId: issue.id, pageId: issue.page_id,
      type: result.type, currentValue: result.currentValue, proposedValue: result.proposedValue, reasoning: result.reasoning,
      aiProvider: result.provider, aiModel: result.model,
    });
    res.status(201).json({ ok: true, recommendation: rec });
  }));

  router.get('/recommendations', asyncH(async (req, res) => {
    const website = await homeWebsite();
    const { issueId, status } = req.query;
    res.json({ recommendations: await store.listRecommendations({
      websiteId: website.id, issueId: issueId ? +issueId : undefined,
      status: REC_STATUSES.includes(status) ? status : undefined,
      limit: Math.min(+req.query.limit || 100, 500), offset: +req.query.offset || 0,
    }) });
  }));

  router.post('/recommendations/:id/approve', asyncH(async (req, res) => {
    const rec = await store.getRecommendation(+req.params.id);
    if (!rec) return res.status(404).json({ ok: false, error: 'Recommendation not found.' });
    if (rec.status !== 'pending') return res.status(409).json({ ok: false, error: `Only a pending recommendation can be approved (this one is ${rec.status}).` });
    res.json({ ok: true, recommendation: await store.setRecommendationStatus(rec.id, 'approved', { reviewedBy: req.user.email }) });
  }));

  router.post('/recommendations/:id/reject', asyncH(async (req, res) => {
    const rec = await store.getRecommendation(+req.params.id);
    if (!rec) return res.status(404).json({ ok: false, error: 'Recommendation not found.' });
    if (rec.status !== 'pending') return res.status(409).json({ ok: false, error: `Only a pending recommendation can be rejected (this one is ${rec.status}).` });
    res.json({ ok: true, recommendation: await store.setRecommendationStatus(rec.id, 'rejected', { reviewedBy: req.user.email }) });
  }));

  // APPLY: the only route that can change production content, and only for an already-approved recommendation.
  router.post('/recommendations/:id/apply', asyncH(async (req, res) => {
    if (await limiter.take(`seo-apply:${req.user.id}`, 20, 10 * 60_000)) {
      return res.status(429).json({ ok: false, error: 'Too many apply requests — please wait a few minutes.' });
    }
    const rec = await store.getRecommendation(+req.params.id);
    if (!rec) return res.status(404).json({ ok: false, error: 'Recommendation not found.' });
    if (rec.status !== 'approved') return res.status(409).json({ ok: false, error: `Only an approved recommendation can be applied (this one is ${rec.status}).` });

    const result = await applyRecommendation(store, rec, { userEmail: req.user.email });
    if (!result.ok) {
      if (result.error === 'manual implementation required') return res.status(501).json({ ok: false, error: result.error, recommendation: rec });   // status stays 'approved'
      await store.setRecommendationStatus(rec.id, 'failed', {});
      return res.status(422).json({ ok: false, error: result.error, details: result.details });
    }
    res.json({ ok: true, recommendation: await store.setRecommendationStatus(rec.id, 'applied', { applied: true }) });
  }));

  return router;
}
