import express from 'express';
import { siteOrigin } from '../../content/seo.js';
import { runScan } from './jobs.js';

const SEVERITIES = ['critical', 'warning', 'info'];

/**
 * /api/admin/seo/* — mounted under the SAME admin router as everything else in server/app.js, so it inherits
 * auth.requireUser, the JSON body parser, auth.csrf, and the no-store/no-index headers already applied there.
 * No second auth system, no separate rate-limit mechanism: `limiter` is the existing DB-backed limiter.
 *
 * Not hardcoded to hkdevlab.com: the domain is read from PUBLIC_URL (falling back to the production default)
 * and resolved to a `websites` row at request time — a second site later is just another row, not a rewrite.
 */
export function createSeoRouter(store, { limiter }) {
  const router = express.Router();
  const asyncH = (fn) => (req, res, next) => fn(req, res, next).catch(next);

  const origin = () => siteOrigin(process.env.PUBLIC_URL);
  const homeWebsite = () => store.ensureWebsite(new URL(origin()).host, 'HK DevLab');

  router.post('/scan', asyncH(async (req, res) => {
    if (await limiter.take(`seo-scan:${req.user.id}`, 10, 10 * 60_000)) {
      return res.status(429).json({ ok: false, error: 'Too many audits started — please wait a few minutes.' });
    }
    const website = await homeWebsite();
    const audit = await runScan(store, website, { origin: origin() });
    res.status(201).json({ ok: true, audit });
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

  router.get('/issues', asyncH(async (req, res) => {
    const website = await homeWebsite();
    const { auditId, severity, status } = req.query;
    const issues = await store.listIssues({
      websiteId: website.id,
      auditId: auditId ? +auditId : undefined,
      severity: SEVERITIES.includes(severity) ? severity : undefined,
      status: typeof status === 'string' && status ? status : undefined,
      limit: Math.min(+req.query.limit || 100, 500),
      offset: +req.query.offset || 0,
    });
    res.json({ issues });
  }));

  return router;
}
