import { createApp } from './app.js';
import { googleEnabled } from './google.js';

/* The normal long-running Node server (Render, a VPS, `npm run dev`, `npm start`).
   On Vercel this file is not used — api/index.js serves the same app as a serverless function. */
try { process.loadEnvFile(); } catch { /* no .env file — real env vars only */ }

// --port=… wins (used by `npm run dev` so the API never collides with Vite); hosts like Render set PORT
const argPort = process.argv.find((a) => a.startsWith('--port='))?.slice(7);
const PORT = +argPort || +process.env.PORT || 8788;
const IS_PROD = process.env.NODE_ENV === 'production';

let ctx;
try { ctx = await createApp(); } catch (e) {
  // never echo DATABASE_URL itself — it contains the password
  console.error(`\nCould not start: ${e.code || e.message}\n${process.env.DATABASE_URL
    ? 'Check DATABASE_URL (the full postgres://… connection string from Neon/Render, copied exactly).'
    : 'Check SQLITE_PATH and that the folder is writable.'}\n`);
  process.exit(1);
}
const { app, store, mailer, hasDist } = ctx;

const server = app.listen(PORT, async () => {
  console.log(`HK DevLab server → http://localhost:${PORT}`);
  console.log(`  database: ${store.kind}`);
  console.log(`  email:    ${mailer.live ? `SMTP → ${mailer.to}` : 'console only (set SMTP_HOST to send real email)'}`);
  console.log(`  google:   ${googleEnabled() ? 'sign-in enabled' : 'not configured (set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)'}`);
  console.log(`  admin:    /admin ${(await store.userCount()) === 0 ? '— NO ACCOUNTS YET: the first person to finish setup becomes admin' : 'ready'}`);
  if ((await store.userCount()) === 0 && IS_PROD && !process.env.SETUP_TOKEN) console.warn('  ⚠ set SETUP_TOKEN so only you can claim the admin account, or finish setup right after deploying');
  if (!hasDist) console.log('  site:     dist/ not built — run `npm run build` (API only for now)');
});
mailer.verify().then(() => mailer.live && console.log('  smtp:     connection verified')).catch((e) => console.error('  smtp:     VERIFY FAILED —', e.message));

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => store.close().finally(() => process.exit(0))));
