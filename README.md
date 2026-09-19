# HK DevLab — website + admin portal + backend

Cinematic scroll-driven site (Vite + vanilla JS + GSAP ScrollTrigger + Lenis) with a Node/Express backend:
a **database-backed admin portal** where every piece of site content can be edited at any time, a contact form
that stores enquiries and emails **contact@hkdevlab.com**, user accounts with roles, and version history.

```bash
npm install
cp .env.example .env          # then edit (see "Settings")
npm run dev                   # site http://localhost:5180 (+ API on :8788, proxied)      needs Node ≥ 22.13
npm run build && npm start    # production: ONE server serves the site, /api and /admin  (PORT from env)
```

## The admin portal (`/admin`)

**First run:** open `/admin`. If no account exists yet you'll see *"Create your admin account"* — **the first person to
complete it becomes the admin**, and setup then closes permanently. Everyone else is added by an admin afterwards.

> **Important once deployed:** until that first account exists, whoever opens `/admin` first would become the admin.
> Either create your account immediately after deploying, or set `SETUP_TOKEN` on the server first — setup then also
> asks for that key, so only you can claim the admin role.

| Area | What it does | Who |
|---|---|---|
| **Site content** | Edit every section of the public site — hero text, statement, tech tiles, services, principles, process steps, projects (the browser windows in the 3D ring), audience band, contact details & form options, footer, SEO title/description. Add, remove and reorder items. **Changes go live the moment you save.** | admin, editor |
| **History** | Every save is kept (latest 40). Restore any earlier version in one click. | admin, editor |
| **Enquiries** | Contact-form messages: mark new / read / replied / spam, reply by email, delete, export CSV. | admin, editor |
| **Users** | Add people, set roles, reset passwords, remove access. | admin only |
| **Account** | Change your own password. | everyone |

### Continue with Google

Once Google is configured (below), the sign-in page shows **Continue with Google** (and **Set up with Google** on first run).
It is deliberately **not** open sign-up — a stranger with a Google account must never become an editor of your website:

| Who | What happens |
|---|---|
| The very first person (no accounts yet) | Becomes the **admin** (and must enter `SETUP_TOKEN` first, if you set one) |
| Someone an admin added under **Users → Add a user** (email + role, *leave the password empty*) | Signs in with Google and gets that role. Their Google email must match the one the admin typed. |
| An existing password account | Is linked to Google on its first Google sign-in (same verified email); the password keeps working |
| Any other Google account | Refused with "ask an admin to add your email". Nothing is created. |

**Set it up (5 minutes):**
1. [Google Cloud Console](https://console.cloud.google.com) → create/select a project → **APIs & Services → OAuth consent screen**:
   User type *External*, app name "HK DevLab", your support email. While the app is in *Testing* mode, add every person who will sign in under
   **Test users** (or click *Publish app* so any Google account can *attempt* sign-in — the invite list above still decides who gets in).
2. **Credentials → Create credentials → OAuth client ID → Web application.** Under **Authorized redirect URIs** add
   `http://localhost:5180/api/auth/google/callback` (for development) and `https://YOUR-DOMAIN/api/auth/google/callback` (production).
3. Copy the **Client ID** and **Client secret** into `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`, and set `PUBLIC_URL=https://YOUR-DOMAIN` in production. Restart.

Roles: **admin** = everything including users · **editor** = content and enquiries. There must always be at least one admin.
Locked out? On the server run `npm run reset-password -- you@example.com "a new long password"`.

What is *not* editable in the portal: the logo/brand images (replace the files in `public/brand/`), colours and layout (code).

## How a contact message travels

```
visitor ─► POST /api/contact ─► validate ─► rate-limit / honeypot / origin check
                                   ├─► database (SQLite file, or PostgreSQL if DATABASE_URL is set)
                                   ├─► email → MAIL_TO (Reply-To = the visitor)
                                   └─► auto-reply → the visitor
```
The visitor is answered as soon as the message is stored; email is sent in the background, so a mail outage never loses
an enquiry (the Enquiries list shows a "notified / email not sent" badge).

## Settings (`.env` locally, your host's environment variables in production)

| Variable | What it does |
|---|---|
| `GOOGLE_CLIENT_ID` `GOOGLE_CLIENT_SECRET` `PUBLIC_URL` | Enable "Continue with Google" (see above). `PUBLIC_URL` = your site's address, must match the redirect URI you registered. |
| `SETUP_TOKEN` | Optional but recommended in production: a private key required during first-run setup. |
| `SMTP_HOST` `SMTP_PORT` `SMTP_SECURE` `SMTP_USER` `SMTP_PASS` | Outgoing email. Without `SMTP_HOST`, emails are only printed to the console. |
| `MAIL_FROM` / `MAIL_TO` | Sender (e.g. `HK DevLab <website@hkdevlab.com>`) and where notifications go (default `contact@hkdevlab.com`). |
| `DATABASE_URL` | `postgres://…` to use PostgreSQL. Empty → SQLite at `SQLITE_PATH` (default `./data/hkdevlab.db`). |
| `IP_HASH_SALT` | Random string; visitor IPs are stored only as salted hashes. |
| `ALLOWED_ORIGINS` | Only if the site is served from a different domain than the API. |
| `NODE_ENV=production` | Enables HTTPS-only cookies and HSTS. Set it in production. |

**Cloudflare Email Routing** only forwards *incoming* mail and cannot send. Use a sending service such as Resend
(free tier): verify `hkdevlab.com` there (add its DNS records in Cloudflare, "DNS only"), create an API key, then
`SMTP_HOST=smtp.resend.com`, `SMTP_PORT=465`, `SMTP_SECURE=true`, `SMTP_USER=resend`, `SMTP_PASS=<api key>`,
`MAIL_FROM="HK DevLab <website@hkdevlab.com>"`, `MAIL_TO=contact@hkdevlab.com` (Cloudflare forwards it to your inbox).
Other mailboxes (Google Workspace `smtp.gmail.com:587` with an app password, Zoho `smtp.zoho.com:587`, …) work too.

## Deploying on Render (recommended)

The site, API and `/admin` are ONE Node server, so it needs a host that runs Node — not a static host (on static hosts such as
Vercel/Netlify `/admin` and `/api/*` simply return 404 and the contact form cannot work).

1. Create a PostgreSQL database (e.g. [Neon](https://neon.tech) free tier) and copy its connection string (`postgres://…`).
2. Render dashboard → **New → Blueprint** → pick this GitHub repo. Render reads [`render.yaml`](render.yaml) and asks for the values
   marked secret: `DATABASE_URL` and `SMTP_PASS` (your Resend API key). `SETUP_TOKEN` and `IP_HASH_SALT` are generated for you.
3. When the first deploy is live, check `https://<service>.onrender.com/api/health` → `"ok": true` and `postgres`.
4. Open `/admin`, enter the `SETUP_TOKEN` (Render → service → Environment) and create your account — **you become the admin**.
5. Custom domain: Render → Settings → Custom Domains, add `hkdevlab.com` + `www`, create the DNS records Render shows, and
   remove the domain from any other host. Then (for Google sign-in) set `PUBLIC_URL=https://hkdevlab.com` and add
   `https://hkdevlab.com/api/auth/google/callback` as an authorised redirect URI.

Free web services sleep after inactivity (first request afterwards is slow) — switch the plan to *Starter* for an always-on site.

### Other hosts

Build once (`npm run build`), then run `npm start`. Works on Render, Railway, Fly, a VPS…
**Ephemeral disks** (Render/Railway/Fly free tiers) erase a SQLite file on every deploy — there, set `DATABASE_URL` to a
PostgreSQL database (tables are created automatically). On a VPS or a persistent volume SQLite is fine; back up `data/`.
Your local database and the production database are separate: the admin account you make locally does not exist online —
create the real one on the live site.

## Security

Passwords hashed with scrypt · server-side sessions in HttpOnly, SameSite=Strict (+ Secure in production) cookies, only a
hash of the token stored · every state-changing admin request needs a custom header + same-origin check (CSRF) ·
login lock-out per account and per address · Google sign-in via OAuth 2.0 code flow with PKCE, single-use state bound to the browser by a cookie, nonce + issuer + audience + expiry + verified-email checks, invite-only, tokens never stored or logged · content is validated against a schema on the server and rendered on the
site as text (never HTML), links limited to `#`, `/`, `http(s)`, `mailto:` and colours to `#rrggbb` · contact form:
validation, honeypot, speed check, 5 messages / 15 min per visitor, Origin check · strict Content-Security-Policy and
other security headers · HTML-escaped emails, header-injection-safe addresses · CSV export neutralises spreadsheet
formulas · no raw IPs stored.

## Layout

```
index.html · src/ (main.js, render.js, modules/, styles/)        the public site
content/  default.json (initial content) · schema.js (the ONE definition of every editable field — used by the
          admin forms and by server-side validation)
server/   index.js · auth.js · db.js · content.js · mail.js · validate.js · admin/ (the portal UI)
public/   brand/ (logos), robots.txt
```
Tests: `node server/test-pg.mjs` exercises the PostgreSQL code path (in-memory emulator) · `node server/test-google.mjs` runs the whole
Google sign-in flow against a fake Google server (PKCE, state, nonce, invites, replays, tampering).
