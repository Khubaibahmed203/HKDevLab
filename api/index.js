import { createApp } from '../server/app.js';

/**
 * Vercel serverless function — serves /api/* and /admin/* (see vercel.json rewrites).
 * The public pages themselves are static files served by Vercel's CDN.
 * The app is built once per warm instance; if building fails (e.g. DATABASE_URL missing) we answer with a generic error,
 * log the reason for the Vercel logs, and try again on the next request.
 */
let ready;

export default async function handler(req, res) {
  try {
    ready ||= createApp();
    const { app } = await ready;
    return app(req, res);
  } catch (e) {
    ready = undefined;
    console.error('[startup] could not start the server:', e.code || e.message);   // never log connection strings
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify({ ok: false, error: 'The server is not configured correctly. Check the deployment logs.' }));
  }
}
