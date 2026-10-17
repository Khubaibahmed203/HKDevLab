import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * Storage. One set of queries (written with ? placeholders), two backends:
 *   • DATABASE_URL set  → PostgreSQL (production / hosts with ephemeral disks)
 *   • otherwise         → SQLite file at SQLITE_PATH (default ./data/hkdevlab.db), zero setup
 * Timestamps are ISO-8601 strings in both, so results look identical.
 */
export const STATUSES = ['new', 'read', 'replied', 'spam'];
export const ROLES = ['admin', 'editor'];
const now = () => new Date().toISOString();
const MAX_VERSIONS = 40;
// The only recommendation status changes production may make; there is no pending → applied (a person must approve first).
const RECOMMENDATION_TRANSITIONS = new Set(['pending>approved', 'pending>rejected', 'approved>applied', 'approved>failed']);
// Phase 4 Hardening #9: a website has at most ONE queued/running audit, and the DATABASE enforces it (a partial unique index). The
// INSERT…WHERE NOT EXISTS in createAuditIfNoneActive() is only a fast path: under PostgreSQL READ COMMITTED two sessions can both see
// "nothing active" and both insert, and nothing but a constraint stops the second.
const ACTIVE_AUDIT_INDEX = 'uq_seo_audits_one_active_per_website';
export const DUPLICATE_ACTIVE_AUDIT_SUMMARY = 'Marked failed at startup: a newer queued or running audit already existed for this website, and only one active audit per website is allowed.';
// True ONLY for a violation of that index. PostgreSQL reports SQLSTATE 23505 plus the violated index's name (so the primary key or any
// other unique constraint is never mistaken for it); pg-mem reports 23505 without a name; SQLite names the column. Everything else is a real failure.
const isActiveAuditConflict = (err) => err?.code === '23505'
  ? !err.constraint || err.constraint === ACTIVE_AUDIT_INDEX
  : /UNIQUE constraint failed: seo_audits\.website_id\b/.test(String(err?.message));

/* ───────────── adapters ───────────── */
async function sqliteAdapter() {
  const { DatabaseSync } = await import('node:sqlite');
  const file = resolve(process.env.SQLITE_PATH || 'data/hkdevlab.db');
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  return {
    kind: `sqlite (${file})`, pk: 'INTEGER PRIMARY KEY AUTOINCREMENT',
    async exec(sql) { db.exec(sql); },
    async all(sql, p = []) { return db.prepare(sql).all(...p); },
    async run(sql, p = []) { return db.prepare(sql).run(...p).changes; },
    async insert(sql, p = []) { const r = db.prepare(sql).run(...p); return r.changes ? Number(r.lastInsertRowid) : null; },
    async close() { db.close(); },
  };
}

// When an IDLE pooled client's connection fails (a database restart, a dropped network), pg-pool purges that client and then emits 'error' on the POOL itself.
// An 'error' event with no listener is thrown, and on a long-running host (the Node/Render server) that ends the process. This listener only has to log: the
// pool has already discarded the broken client. The line is built from the error's short code alone — pg error messages and error objects can carry user names
// and connection details, so neither the message nor any other property is ever logged. One listener per pool, however often it is initialised.
const guardedPools = new WeakSet();
const safeErrorCode = (err) => (typeof err?.code === 'string' && /^[A-Za-z0-9_]{1,24}$/.test(err.code) ? err.code : 'unknown');
export function guardPoolErrors(pool) {
  if (!pool || typeof pool.on !== 'function' || guardedPools.has(pool)) return pool;
  guardedPools.add(pool);
  pool.on('error', (err) => console.error(`[db] a PostgreSQL connection failed while idle (${safeErrorCode(err)}); the pool discarded it and carries on`));
  return pool;
}

// TLS for a PostgreSQL URL. A remote database is reached over TLS that checks the server's certificate AND hostname (rejectUnauthorized stays on). Only a loopback
// destination skips TLS, and "loopback" is judged on the host pg will actually dial — `?host=` or an empty host can change it — never by searching the URL text, so a
// password, user or database name containing "localhost" cannot switch TLS off. Options written in the URL itself (sslmode=…, ssl=…) are applied by pg ON TOP of this
// value and are deliberately left alone: on the installed pg 8, sslmode=require / verify-full / prefer / verify-ca keep full verification, while sslmode=no-verify,
// sslmode=disable, ssl=0 and uselibpqcompat=true with prefer/require turn verification (or TLS itself) off — those stay the operator's explicit, visible choice.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
function pgSslFor(pg, connectionString) {
  let host;
  try { host = new pg.Client({ connectionString }).host; } catch { /* unparseable: not loopback, so verified TLS; the pool reports the parse error at its first query */ }
  return typeof host === 'string' && LOOPBACK_HOSTS.has(host.toLowerCase()) ? false : { rejectUnauthorized: true };
}

async function pgAdapter(poolOrUrl) {
  let pool = poolOrUrl;
  if (typeof poolOrUrl === 'string') {
    const { default: pg } = await import('pg');
    pool = new pg.Pool({ connectionString: poolOrUrl, ssl: pgSslFor(pg, poolOrUrl), max: 5 });
  }
  guardPoolErrors(pool);                     // the pool built above and any injected pool that supports .on()
  const numbered = (sql) => { let n = 0; return sql.replace(/\?/g, () => `$${++n}`); };
  return {
    kind: 'postgres', pk: 'BIGSERIAL PRIMARY KEY',
    async exec(sql) { await pool.query(sql); },
    async all(sql, p = []) { return (await pool.query(numbered(sql), p)).rows; },
    async run(sql, p = []) { return (await pool.query(numbered(sql), p)).rowCount; },
    async insert(sql, p = []) { const rows = (await pool.query(`${numbered(sql)} RETURNING id`, p)).rows; return rows[0] ? Number(rows[0].id) : null; },
    async close() { await pool.end(); },
  };
}

/* ───────────── store ───────────── */
export async function createStore({ pool } = {}) {
  const db = pool ? await pgAdapter(pool) : process.env.DATABASE_URL ? await pgAdapter(process.env.DATABASE_URL) : await sqliteAdapter();

  await db.exec([
    `CREATE TABLE IF NOT EXISTS enquiries (
       id ${db.pk}, created_at TEXT NOT NULL, name TEXT NOT NULL, email TEXT NOT NULL, service TEXT NOT NULL,
       message TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'new', email_sent INTEGER NOT NULL DEFAULT 0,
       ip_hash TEXT, user_agent TEXT)`,
    `CREATE TABLE IF NOT EXISTS users (
       id ${db.pk}, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, password_hash TEXT NOT NULL,
       role TEXT NOT NULL DEFAULT 'editor', created_at TEXT NOT NULL, last_login_at TEXT, google_sub TEXT)`,
    `CREATE TABLE IF NOT EXISTS oauth_states (
       state_hash TEXT PRIMARY KEY, verifier TEXT NOT NULL, nonce TEXT NOT NULL,
       setup_ok INTEGER NOT NULL DEFAULT 0, expires_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS sessions (
       id ${db.pk}, user_id BIGINT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
       created_at TEXT NOT NULL, expires_at TEXT NOT NULL, user_agent TEXT)`,
    `CREATE TABLE IF NOT EXISTS rate_events (
       id ${db.pk}, k TEXT NOT NULL, ts BIGINT NOT NULL)`,
    'CREATE INDEX IF NOT EXISTS idx_rate_events ON rate_events (k, ts)',
    `CREATE TABLE IF NOT EXISTS content (
       key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT)`,
    `CREATE TABLE IF NOT EXISTS content_versions (
       id ${db.pk}, created_at TEXT NOT NULL, user_email TEXT, note TEXT, value TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS media (
       id TEXT PRIMARY KEY, mime TEXT NOT NULL, data TEXT NOT NULL,
       size INTEGER NOT NULL, created_at TEXT NOT NULL, created_by TEXT)`,
    // SEO Agent foundation (Phase 1): one row per managed site today, shaped so a second site is just another row.
    `CREATE TABLE IF NOT EXISTS websites (
       id ${db.pk}, domain TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
       created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS pages (
       id ${db.pk}, website_id BIGINT NOT NULL, url TEXT NOT NULL, title TEXT, description TEXT,
       status_code INTEGER, last_crawled_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
       UNIQUE (website_id, url))`,
    'CREATE INDEX IF NOT EXISTS idx_pages_website ON pages (website_id)',
    `CREATE TABLE IF NOT EXISTS seo_audits (
       id ${db.pk}, website_id BIGINT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT,
       score INTEGER, status TEXT NOT NULL DEFAULT 'running', summary TEXT)`,
    'CREATE INDEX IF NOT EXISTS idx_seo_audits_website ON seo_audits (website_id)',
    `CREATE TABLE IF NOT EXISTS seo_issues (
       id ${db.pk}, website_id BIGINT NOT NULL, audit_id BIGINT NOT NULL, page_id BIGINT,
       type TEXT NOT NULL, severity TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
       detail TEXT, recommendation TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    'CREATE INDEX IF NOT EXISTS idx_seo_issues_audit ON seo_issues (audit_id)',
    'CREATE INDEX IF NOT EXISTS idx_seo_issues_website ON seo_issues (website_id)',
    // Phase 2: the internal-link graph (edges discovered by one crawl) and AI recommendations (never applied
    // without a human approval step — see server/seo/apply.js).
    `CREATE TABLE IF NOT EXISTS page_links (
       id ${db.pk}, website_id BIGINT NOT NULL, audit_id BIGINT NOT NULL, from_page_id BIGINT NOT NULL,
       to_url TEXT NOT NULL, to_page_id BIGINT, anchor_text TEXT, is_internal INTEGER NOT NULL DEFAULT 1,
       created_at TEXT NOT NULL)`,
    'CREATE INDEX IF NOT EXISTS idx_page_links_audit ON page_links (audit_id)',
    'CREATE INDEX IF NOT EXISTS idx_page_links_to ON page_links (to_page_id)',
    `CREATE TABLE IF NOT EXISTS seo_recommendations (
       id ${db.pk}, website_id BIGINT NOT NULL, issue_id BIGINT NOT NULL, page_id BIGINT,
       type TEXT NOT NULL, current_value TEXT, proposed_value TEXT, reasoning TEXT,
       ai_provider TEXT, ai_model TEXT, status TEXT NOT NULL DEFAULT 'pending',
       created_at TEXT NOT NULL, reviewed_at TEXT, reviewed_by TEXT, applied_at TEXT)`,
    'CREATE INDEX IF NOT EXISTS idx_seo_recommendations_website ON seo_recommendations (website_id)',
    'CREATE INDEX IF NOT EXISTS idx_seo_recommendations_issue ON seo_recommendations (issue_id)',
  ].join(';\n'));
  // databases created before Google sign-in existed lack this column
  try { await db.exec(`ALTER TABLE users ADD COLUMN ${db.kind === 'postgres' ? 'IF NOT EXISTS ' : ''}google_sub TEXT`); } catch { /* already there */ }

  // Phase 2: `pages` and `seo_audits` grew new columns for the real crawler's facts. SQLite has no
  // "ADD COLUMN IF NOT EXISTS", so every call is wrapped and a repeat run's "duplicate column" error is
  // swallowed — the same pattern already used for users.google_sub above.
  const addColumn = async (table, column, type) => {
    try { await db.exec(`ALTER TABLE ${table} ADD COLUMN ${db.kind === 'postgres' ? 'IF NOT EXISTS ' : ''}${column} ${type}`); } catch { /* already there */ }
  };
  for (const [column, type] of [
    ['final_url', 'TEXT'], ['content_type', 'TEXT'], ['canonical', 'TEXT'], ['robots', 'TEXT'],
    ['h1_count', 'INTEGER'], ['h2_count', 'INTEGER'], ['word_count', 'INTEGER'], ['html_size', 'INTEGER'],
    ['response_time_ms', 'INTEGER'], ['depth', 'INTEGER'], ['image_count', 'INTEGER'], ['images_missing_alt', 'INTEGER'],
    ['lang', 'TEXT'], ['og_title', 'TEXT'], ['og_description', 'TEXT'], ['og_image', 'TEXT'], ['twitter_card', 'TEXT'],
    ['json_ld_present', 'INTEGER'], ['last_audit_id', 'BIGINT'],
  ]) await addColumn('pages', column, type);
  for (const [column, type] of [
    ['base_url', 'TEXT'], ['pages_crawled', 'INTEGER'], ['pages_planned', 'INTEGER'], ['errors_count', 'INTEGER'],
    ['duration_ms', 'INTEGER'], ['pagespeed', 'TEXT'], ['specialist_diagnostics', 'TEXT'],
  ]) await addColumn('seo_audits', column, type);
  // Phase 3 Step 2: recommendation-level verification. `issue_id` already IS the reliable link to the
  // originating issue (NOT NULL since Phase 2 — see createRecommendation below), so no new linking column is
  // needed; these three just record the outcome once a later scan checks whether that issue is still present.
  for (const [column, type] of [
    ['verified_status', 'TEXT'], ['verified_at', 'TEXT'], ['verified_audit_id', 'BIGINT'],
  ]) await addColumn('seo_recommendations', column, type);
  // Phase 4 (stale-value guard): the site's own seo.title / seo.description at the moment a title/description recommendation was
  // created (see createRecommendation). Plain nullable TEXT, additive: rows that predate it, and every other type, stay NULL, and
  // NULL means "no guard" — exactly the behaviour those rows always had.
  await addColumn('seo_recommendations', 'base_value', 'TEXT');
  // Phase 4 Hardening #3: the site content row's revision counter (see saveContentIfVersion). Deliberately a plain nullable
  // INTEGER: rows that predate it are NULL (SQLite, PostgreSQL and pg-mem do not all back-fill a default), and every read
  // and write below treats NULL as version 0.
  await addColumn('content', 'version', 'INTEGER');

  // Phase 4 Hardening #9: one active audit per website, enforced by a partial unique index. A database that predates it may already hold
  // several queued/running audits for one website (the race this closes, or manual edits), and the index cannot be built over them — so
  // first fail every active audit that a NEWER active audit of the same website supersedes. The survivor is the highest id, the same audit
  // activeAudit() and latestAudit() already treat as "the current one", and the same outcome stale recovery gives an audit that a newer scan
  // replaced; a failed audit's worker is already handled (finishAudit refuses it, executeScan stops). History (complete/failed rows) and every
  // website with a single active audit are untouched. The UPDATE is idempotent: a second run finds nothing to change.
  const normalizeActiveAudits = async () => {
    const changed = await db.run(
      `UPDATE seo_audits SET status = 'failed', finished_at = ?, summary = ?
       WHERE status IN ('queued','running')
         AND id NOT IN (SELECT MAX(id) FROM seo_audits WHERE status IN ('queued','running') GROUP BY website_id)`,
      [now(), DUPLICATE_ACTIVE_AUDIT_SUMMARY]);
    if (changed > 0) console.error(`[db] failed ${changed} duplicate active audit(s): a website may have only one queued/running audit — kept the newest of each`);
  };
  // Another instance still running the previous code can insert a duplicate between the normalization and the index build (the index then
  // cannot be built), and two instances starting together can collide on the DDL itself: normalize again and retry, then fail loudly — a
  // server that silently runs without the index would look protected and not be.
  for (let attempt = 1; ; attempt++) {
    await normalizeActiveAudits();
    try {
      await db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ${ACTIVE_AUDIT_INDEX} ON seo_audits (website_id) WHERE status IN ('queued','running')`);
      break;
    } catch (err) {
      if (attempt >= 3) throw err;
      console.error(`[db] could not build the one-active-audit index (attempt ${attempt} of 3): ${String(err?.message).slice(0, 200)} — repairing and retrying`);
    }
  }

  const enq = (r) => ({ ...r, id: Number(r.id), email_sent: !!Number(r.email_sent) });
  const website = (r) => r && { ...r, id: Number(r.id) };
  const int = (v) => (v == null ? null : Number(v));
  const page = (r) => r && {
    ...r, id: Number(r.id), website_id: Number(r.website_id),
    status_code: int(r.status_code), h1_count: int(r.h1_count), h2_count: int(r.h2_count), word_count: int(r.word_count),
    html_size: int(r.html_size), response_time_ms: int(r.response_time_ms), depth: int(r.depth),
    image_count: int(r.image_count), images_missing_alt: int(r.images_missing_alt), last_audit_id: int(r.last_audit_id),
    json_ld_present: r.json_ld_present == null ? null : !!Number(r.json_ld_present),
  };
  const audit = (r) => r && {
    ...r, id: Number(r.id), website_id: Number(r.website_id), score: int(r.score),
    pages_crawled: int(r.pages_crawled), pages_planned: int(r.pages_planned), errors_count: int(r.errors_count), duration_ms: int(r.duration_ms),
    pagespeed: r.pagespeed ? JSON.parse(r.pagespeed) : null,
    specialist_diagnostics: r.specialist_diagnostics ? JSON.parse(r.specialist_diagnostics) : null,
  };
  const seoIssue = (r) => r && { ...r, id: Number(r.id), website_id: Number(r.website_id), audit_id: Number(r.audit_id), page_id: r.page_id == null ? null : Number(r.page_id) };
  const pageLink = (r) => r && { ...r, id: Number(r.id), website_id: Number(r.website_id), audit_id: Number(r.audit_id), from_page_id: Number(r.from_page_id), to_page_id: r.to_page_id == null ? null : Number(r.to_page_id), is_internal: !!Number(r.is_internal) };
  const recommendation = (r) => r && {
    ...r, id: Number(r.id), website_id: Number(r.website_id), issue_id: Number(r.issue_id), page_id: r.page_id == null ? null : Number(r.page_id),
    verified_audit_id: r.verified_audit_id == null ? null : Number(r.verified_audit_id),
  };
  const user = (r) => r && {
    id: Number(r.id), email: r.email, name: r.name, role: r.role, created_at: r.created_at, last_login_at: r.last_login_at,
    hasPassword: String(r.password_hash || '').startsWith('scrypt:'), googleLinked: !!r.google_sub,
  };
  // site content: the history entry written after a successful content write, and the insert-only creation of the row.
  const recordContentVersion = async (at, userEmail, note, value) => {
    await db.insert('INSERT INTO content_versions (created_at,user_email,note,value) VALUES (?,?,?,?)', [at, userEmail, note || null, value]);
    await db.run(`DELETE FROM content_versions WHERE id NOT IN (SELECT id FROM (SELECT id FROM content_versions ORDER BY id DESC LIMIT ${MAX_VERSIONS}) keep)`);
  };
  // Insert-only: if the row already exists the primary key refuses the INSERT (PostgreSQL 23505, SQLite "UNIQUE constraint failed"),
  // which here only means "someone else has it" — the existing row is never touched. Any other error is a real failure and is thrown.
  const insertContentIfAbsent = async (value, at, userEmail, version) => {
    try { await db.run("INSERT INTO content (key,value,updated_at,updated_by,version) VALUES ('site',?,?,?,?)", [value, at, userEmail, version]); return true; }
    catch (err) { if (err?.code === '23505' || /UNIQUE constraint failed/i.test(String(err?.message))) return false; throw err; }
  };

  return {
    kind: db.kind,
    async ping() { await db.all('SELECT 1 AS ok'); },
    async close() { await db.close(); },

    /* enquiries */
    async insert(e) {
      return db.insert('INSERT INTO enquiries (created_at,name,email,service,message,ip_hash,user_agent) VALUES (?,?,?,?,?,?,?)',
        [now(), e.name, e.email, e.service, e.message, e.ipHash, e.userAgent]);
    },
    async list({ status, limit = 200, offset = 0 } = {}) {
      const rows = status
        ? await db.all('SELECT * FROM enquiries WHERE status = ? ORDER BY id DESC LIMIT ? OFFSET ?', [status, limit, offset])
        : await db.all('SELECT * FROM enquiries ORDER BY id DESC LIMIT ? OFFSET ?', [limit, offset]);
      return rows.map(enq);
    },
    async counts() {
      const out = { total: 0 };
      STATUSES.forEach((s) => (out[s] = 0));
      for (const r of await db.all('SELECT status, COUNT(*) AS n FROM enquiries GROUP BY status')) { out[r.status] = Number(r.n); out.total += Number(r.n); }
      return out;
    },
    async setStatus(id, status) { return (await db.run('UPDATE enquiries SET status = ? WHERE id = ?', [status, id])) > 0; },
    async setEmailed(id, ok) { await db.run('UPDATE enquiries SET email_sent = ? WHERE id = ?', [ok ? 1 : 0, id]); },
    async remove(id) { return (await db.run('DELETE FROM enquiries WHERE id = ?', [id])) > 0; },

    /* users */
    async userCount() { return Number((await db.all('SELECT COUNT(*) AS n FROM users'))[0].n); },
    async adminCount() { return Number((await db.all("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'"))[0].n); },
    async createUser({ email, name, passwordHash, role }) {
      return db.insert('INSERT INTO users (email,name,password_hash,role,created_at) VALUES (?,?,?,?,?)', [email, name, passwordHash, role, now()]);
    },
    /** Creates the user ONLY if no user exists yet — one atomic statement, so of any number of simultaneous
     *  attempts (even on different servers) exactly one wins. Returns the new id, or null if someone already exists. */
    async createFirstUser({ email, name, passwordHash, role }) {
      return db.insert('INSERT INTO users (email,name,password_hash,role,created_at) SELECT ?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM users)', [email, name, passwordHash, role, now()]);
    },
    async userByEmail(email) { return (await db.all('SELECT * FROM users WHERE email = ?', [email]))[0] || null; },     // includes password_hash
    async userById(id) { return user((await db.all('SELECT * FROM users WHERE id = ?', [id]))[0]); },
    async userWithHash(id) { return (await db.all('SELECT * FROM users WHERE id = ?', [id]))[0] || null; },
    async listUsers() { return (await db.all('SELECT * FROM users ORDER BY id')).map(user); },
    async updateUser(id, f) {
      const sets = [], vals = [];
      for (const [col, key] of [['name', 'name'], ['role', 'role'], ['password_hash', 'passwordHash'], ['email', 'email']]) if (f[key] !== undefined) { sets.push(`${col} = ?`); vals.push(f[key]); }
      if (!sets.length) return false;
      return (await db.run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, [...vals, id])) > 0;
    },
    async userByGoogleSub(sub) { return (await db.all('SELECT * FROM users WHERE google_sub = ?', [sub]))[0] || null; },
    async linkGoogle(id, sub) { await db.run('UPDATE users SET google_sub = ? WHERE id = ?', [sub, id]); },

    /* one-time OAuth login attempts (state, PKCE verifier, nonce) */
    async createOAuthState({ hash, verifier, nonce, setupOk, expiresAt }) {
      await db.run('DELETE FROM oauth_states WHERE expires_at < ?', [now()]);
      await db.run('INSERT INTO oauth_states (state_hash,verifier,nonce,setup_ok,expires_at) VALUES (?,?,?,?,?)', [hash, verifier, nonce, setupOk ? 1 : 0, expiresAt]);
    },
    async takeOAuthState(hash) {                                    // single use: read, then delete
      const r = (await db.all('SELECT * FROM oauth_states WHERE state_hash = ?', [hash]))[0];
      if (!r) return null;
      if ((await db.run('DELETE FROM oauth_states WHERE state_hash = ?', [hash])) === 0) return null;   // someone else took it first
      return r.expires_at > now() ? { verifier: r.verifier, nonce: r.nonce, setupOk: !!Number(r.setup_ok) } : null;
    },

    async touchLogin(id) { await db.run('UPDATE users SET last_login_at = ? WHERE id = ?', [now(), id]); },
    async deleteUser(id) { await db.run('DELETE FROM sessions WHERE user_id = ?', [id]); return (await db.run('DELETE FROM users WHERE id = ?', [id])) > 0; },

    /* sessions (only a hash of the token is stored) */
    async createSession(userId, tokenHash, expiresAt, userAgent) {
      await db.run('DELETE FROM sessions WHERE expires_at < ?', [now()]);
      return db.insert('INSERT INTO sessions (user_id,token_hash,created_at,expires_at,user_agent) VALUES (?,?,?,?,?)', [userId, tokenHash, now(), expiresAt, userAgent]);
    },
    async sessionUser(tokenHash) {
      const r = (await db.all(`SELECT u.*, s.expires_at AS s_expires FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`, [tokenHash]))[0];
      return r && r.s_expires > now() ? { ...user(r), expiresAt: r.s_expires } : null;
    },
    async extendSession(tokenHash, expiresAt) { await db.run('UPDATE sessions SET expires_at = ? WHERE token_hash = ?', [expiresAt, tokenHash]); },
    async deleteSession(tokenHash) { await db.run('DELETE FROM sessions WHERE token_hash = ?', [tokenHash]); },
    async deleteUserSessions(userId, exceptHash) {
      if (exceptHash) await db.run('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?', [userId, exceptHash]);
      else await db.run('DELETE FROM sessions WHERE user_id = ?', [userId]);
    },

    /* rate limiting (see limits.js) */
    /** Records one hit and resolves to its row id, so the caller can later give back exactly that hit (rateRelease). */
    async rateHit(key) {
      const t = Date.now();
      const id = await db.insert('INSERT INTO rate_events (k, ts) VALUES (?,?)', [key, t]);
      if (Math.random() < 0.05) await db.run('DELETE FROM rate_events WHERE ts < ?', [t - 3_600_000]);     // housekeeping
      return id;
    },
    async rateCount(key, windowMs) { return Number((await db.all('SELECT COUNT(*) AS n FROM rate_events WHERE k = ? AND ts > ?', [key, Date.now() - windowMs]))[0].n); },
    /** Deletes one hit by its id (the one rateHit returned) — never any other row, so it cannot disturb a concurrent caller's hit. */
    async rateRelease(id) { await db.run('DELETE FROM rate_events WHERE id = ?', [id]); },
    async rateClear(key) { await db.run('DELETE FROM rate_events WHERE k = ?', [key]); },

    /* site content (+ version history). `version` is the row's revision: NULL (a row from before the column existed) reads as 0,
       and every write moves it up. content_versions is history only — the version on the content row is what guards writes. */
    async getContent() {
      const r = (await db.all("SELECT value, updated_at, updated_by, version FROM content WHERE key = 'site'"))[0];
      return r ? { data: JSON.parse(r.value), updatedAt: r.updated_at, updatedBy: r.updated_by, version: r.version == null ? 0 : Number(r.version) } : null;
    },
    /** Compare-and-swap: replaces the document only while the row is STILL at `expectedVersion` (the version the caller read
     *  together with the document it edited). Returns { ok: true, version, updatedAt }, or { ok: false, conflict: true } when
     *  the row has moved on. A conflict changes nothing at all: no content write, no version change, no history row. There is
     *  deliberately no fallback to an unconditional write here. A missing row counts as version 0, so that the very first
     *  write may create it — creation is insert-only and can never replace a row that exists. */
    async saveContentIfVersion(data, userEmail, note, expectedVersion) {
      if (!Number.isInteger(expectedVersion) || expectedVersion < 0) throw new Error(`Invalid expected content version: ${expectedVersion}`);
      const value = JSON.stringify(data), at = now(), next = expectedVersion + 1;
      let written = (await db.run(
        "UPDATE content SET value = ?, updated_at = ?, updated_by = ?, version = ? WHERE key = 'site' AND COALESCE(version, 0) = ?",
        [value, at, userEmail, next, expectedVersion])) > 0;
      if (!written && expectedVersion === 0) written = await insertContentIfAbsent(value, at, userEmail, next);
      if (!written) return { ok: false, conflict: true };
      await recordContentVersion(at, userEmail, note, value);
      return { ok: true, version: next, updatedAt: at };
    },
    /** First-start creation of the default document: inserts only when there is no row, so it can never replace content.
     *  Returns whether it created the row. */
    async seedContentIfAbsent(data, userEmail, note) {
      const value = JSON.stringify(data), at = now();
      if (!(await insertContentIfAbsent(value, at, userEmail, 0))) return false;
      await recordContentVersion(at, userEmail, note, value);
      return true;
    },
    /** UNCONDITIONAL replace — no production code calls this any more (writes go through saveContentIfVersion, first start
     *  through seedContentIfAbsent); it remains for test fixtures and one-off tooling. It still advances the version, so a
     *  writer holding an older snapshot is refused afterwards instead of silently overwriting. */
    async saveContent(data, userEmail, note) {
      const value = JSON.stringify(data), at = now();
      if ((await db.run("UPDATE content SET value = ?, updated_at = ?, updated_by = ?, version = COALESCE(version, 0) + 1 WHERE key = 'site'", [value, at, userEmail])) === 0) {
        try { await db.run("INSERT INTO content (key,value,updated_at,updated_by,version) VALUES ('site',?,?,?,0)", [value, at, userEmail]); }
        catch { await db.run("UPDATE content SET value = ?, updated_at = ?, updated_by = ?, version = COALESCE(version, 0) + 1 WHERE key = 'site'", [value, at, userEmail]); }   // lost a race to another server
      }
      await recordContentVersion(at, userEmail, note, value);
      return at;
    },
    async listVersions() { return (await db.all('SELECT id, created_at, user_email, note FROM content_versions ORDER BY id DESC LIMIT 40')).map((r) => ({ ...r, id: Number(r.id) })); },
    async getVersion(id) { const r = (await db.all('SELECT value FROM content_versions WHERE id = ?', [id]))[0]; return r ? JSON.parse(r.value) : null; },

    /* uploaded photos, kept as base64 text (identical on SQLite and Postgres — no binary-column quirks). The id is a hash of
       the bytes, so the same photo is stored once and its address never changes. */
    async saveMedia({ id, mime, bytes, by }) {
      await db.run('INSERT INTO media (id,mime,data,size,created_at,created_by) VALUES (?,?,?,?,?,?) ON CONFLICT (id) DO NOTHING', [id, mime, bytes.toString('base64'), bytes.length, now(), by]);
    },
    async getMedia(id) {
      const r = (await db.all('SELECT mime, data FROM media WHERE id = ?', [id]))[0];
      return r ? { mime: r.mime, bytes: Buffer.from(r.data, 'base64') } : null;
    },

    /* SEO Agent foundation (Phase 1) — websites */
    async ensureWebsite(domain, name) {
      const existing = (await db.all('SELECT * FROM websites WHERE domain = ?', [domain]))[0];
      if (existing) return website(existing);
      const at = now();
      const id = await db.insert('INSERT INTO websites (domain,name,created_at,updated_at) VALUES (?,?,?,?)', [domain, name, at, at]);
      return { id, domain, name, created_at: at, updated_at: at };
    },
    async getWebsite(id) { return website((await db.all('SELECT * FROM websites WHERE id = ?', [id]))[0]); },

    /* pages: current known facts for one crawlable URL, upserted by (website, url) — a page's row always
       reflects its MOST RECENT crawl; per-audit history lives in seo_issues/page_links via audit_id.
       OWNERSHIP: with an `auditId`, the write is REFUSED — nothing changes, and the existing row's id is still returned — when the
       row is already owned (last_audit_id) by a strictly NEWER audit of this same website. That is how a worker whose audit was
       recovered as stale (so it is older than the audit that replaced it) can never overwrite, or move backwards, what the newer
       audit established. The condition lives in the UPDATE itself, so it holds however the writers interleave: PostgreSQL re-checks
       it against the row's latest version when two writers collide. Audit ids only grow and are never reused (AUTOINCREMENT /
       BIGSERIAL), and only an id that really is an audit of THIS website counts as a newer owner, so an empty (legacy) or foreign or
       unknown last_audit_id never blocks anyone. Without an `auditId` nothing claims ownership and the write is unconditional,
       exactly as before. */
    async upsertPage({ websiteId, url, finalUrl, statusCode, contentType, title, description, canonical, robots,
      h1Count, h2Count, wordCount, htmlSize, responseTimeMs, depth, imageCount, imagesMissingAlt, lang,
      ogTitle, ogDescription, ogImage, twitterCard, jsonLdPresent, auditId }) {
      const at = now();
      const vals = [finalUrl || null, statusCode ?? null, contentType || null, title || null, description || null, canonical || null, robots || null,
        h1Count ?? null, h2Count ?? null, wordCount ?? null, htmlSize ?? null, responseTimeMs ?? null, depth ?? null,
        imageCount ?? null, imagesMissingAlt ?? null, lang || null, ogTitle || null, ogDescription || null, ogImage || null,
        twitterCard || null, jsonLdPresent == null ? null : (jsonLdPresent ? 1 : 0), auditId ?? null];
      const find = async () => (await db.all('SELECT id FROM pages WHERE website_id = ? AND url = ?', [websiteId, url]))[0];
      let existing = await find();
      if (!existing) {
        try {
          return await db.insert(
            `INSERT INTO pages (website_id,url,final_url,status_code,content_type,title,description,canonical,robots,
               h1_count,h2_count,word_count,html_size,response_time_ms,depth,image_count,images_missing_alt,lang,
               og_title,og_description,og_image,twitter_card,json_ld_present,last_audit_id,last_crawled_at,created_at,updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [websiteId, url, ...vals, at, at, at]);
        } catch (err) {
          // another writer — typically the newer audit — created this very page between our read and our insert: it exists now, so take the ordinary guarded update below
          if (!(err?.code === '23505' || /UNIQUE constraint failed/i.test(String(err?.message)))) throw err;
          existing = await find();
          if (!existing) throw err;
        }
      }
      const SET = `final_url=?, status_code=?, content_type=?, title=?, description=?, canonical=?, robots=?,
             h1_count=?, h2_count=?, word_count=?, html_size=?, response_time_ms=?, depth=?, image_count=?, images_missing_alt=?,
             lang=?, og_title=?, og_description=?, og_image=?, twitter_card=?, json_ld_present=?, last_audit_id=?,
             last_crawled_at=?, updated_at=?`;
      if (auditId == null) await db.run(`UPDATE pages SET ${SET} WHERE id=?`, [...vals, at, at, existing.id]);
      else await db.run(
        `UPDATE pages SET ${SET} WHERE id=? AND (last_audit_id IS NULL OR NOT (last_audit_id > ? AND last_audit_id IN (SELECT id FROM seo_audits WHERE website_id = ?)))`,
        [...vals, at, at, existing.id, auditId, websiteId]);
      return Number(existing.id);
    },
    async listPages(websiteId) { return (await db.all('SELECT * FROM pages WHERE website_id = ? ORDER BY id', [websiteId])).map(page); },
    async getPage(id) { return page((await db.all('SELECT * FROM pages WHERE id = ?', [id]))[0]); },

    /* SEO audits (one row per SCAN→ANALYZE run). `status` defaults to 'running' so every pre-Phase-2.1
       caller (existing tests, direct store use) keeps working unchanged; the async job queue (server/seo/
       jobs.js) is the only caller that passes status: 'queued' and lets claimAudit() below move it along.
       This helper is unguarded and for tests: since Hardening #9 the database refuses a second queued/running audit for a website,
       so it throws (a unique violation) if one is already active — production creates audits only through createAuditIfNoneActive(). */
    async createAudit(websiteId, { baseUrl, pagesPlanned, status = 'running' } = {}) {
      const at = now();
      const id = await db.insert('INSERT INTO seo_audits (website_id,started_at,status,base_url,pages_planned) VALUES (?,?,?,?,?)', [websiteId, at, status, baseUrl || null, pagesPlanned ?? null]);
      return { id, website_id: websiteId, started_at: at, finished_at: null, score: null, status, summary: null, base_url: baseUrl || null, pages_planned: pagesPlanned ?? null };
    },
    /** Atomic compare-and-swap: 'queued' → 'running'. Whichever caller's UPDATE actually changes a row (the
     *  background job kick, or a poll request's fallback — see ensureProgressing() in jobs.js) is the one
     *  that goes on to run the crawl; the loser sees 0 rows changed and does nothing. This is what makes it
     *  safe for both to race without ever crawling the same audit twice. */
    async claimAudit(id) { return (await db.run("UPDATE seo_audits SET status = 'running' WHERE id = ? AND status = 'queued'", [id])) > 0; },
    /** Duplicate-scan protection: is there already a queued or running audit for this website? */
    async activeAudit(websiteId) {
      return audit((await db.all("SELECT * FROM seo_audits WHERE website_id = ? AND status IN ('queued','running') ORDER BY id DESC LIMIT 1", [websiteId]))[0]);
    },
    /** Duplicate-scan protection: inserts a new 'queued' audit ONLY if no queued/running one already exists for
     *  this website, and returns the new audit — or null if one was already active.
     *  Two layers, and only the second is the guarantee. The INSERT…SELECT…WHERE NOT EXISTS (same pattern as
     *  createFirstUser() above) turns the ordinary duplicate into a plain "0 rows inserted". But under PostgreSQL's
     *  default READ COMMITTED two concurrent sessions can both see "nothing active" and both insert, so the partial
     *  unique index on (website_id) for queued/running rows (see createStore) is the authority: the loser's INSERT
     *  is rejected by the database, and exactly that violation — nothing else — is reported as null, i.e. "already
     *  active", which the route already turns into its 409. Any other error is a real failure and is thrown. */
    async createAuditIfNoneActive(websiteId, { baseUrl, pagesPlanned } = {}) {
      const at = now();
      // CAST(...) on the bare (tableless) SELECT's numeric placeholders: without it, Postgres/pg-mem can't
      // infer a type for a literal `?` here (there's no source column to infer it from, unlike a plain
      // INSERT ... VALUES) and guesses 'text', which then fails against website_id's BIGINT column. SQLite
      // accepts the same CAST syntax too (its "INT"-containing type names just select integer affinity), so
      // one query string still works unmodified on both backends.
      let id;
      try {
        id = await db.insert(
          `INSERT INTO seo_audits (website_id,started_at,status,base_url,pages_planned)
           SELECT CAST(? AS BIGINT), ?, 'queued', ?, CAST(? AS BIGINT)
           WHERE NOT EXISTS (SELECT 1 FROM seo_audits WHERE website_id = CAST(? AS BIGINT) AND status IN ('queued','running'))`,
          [websiteId, at, baseUrl || null, pagesPlanned ?? null, websiteId]);
      } catch (err) {
        if (isActiveAuditConflict(err)) return null;
        throw err;
      }
      return id ? { id, website_id: websiteId, started_at: at, finished_at: null, score: null, status: 'queued', summary: null, base_url: baseUrl || null, pages_planned: pagesPlanned ?? null } : null;
    },
    /** Terminal transition (complete/failed). Guarded so it can only ever leave a non-terminal state: an audit
     *  that stale recovery (or anything else) already moved to failed/complete is never overwritten. Resolves to
     *  true only if THIS call changed the row — false means another process got there first, and the caller must
     *  not treat its own result as recorded. */
    async finishAudit(id, { score, status, summary, pagesCrawled, errorsCount, durationMs, pagespeed }) {
      return (await db.run(
        "UPDATE seo_audits SET finished_at=?, score=?, status=?, summary=?, pages_crawled=?, errors_count=?, duration_ms=?, pagespeed=? WHERE id=? AND status IN ('queued','running')",
        [now(), score ?? null, status, summary || null, pagesCrawled ?? null, errorsCount ?? null, durationMs ?? null, pagespeed ? JSON.stringify(pagespeed) : null, id])) > 0;
    },
    /** Stale-audit recovery: one atomic UPDATE that fails this website's queued/running audits whose started_at
     *  (an ISO string, same format as `cutoff`) is older than `cutoff`. Idempotent — a second call finds nothing.
     *  Resolves to how many audits it recovered. Never touches pages, issues, links or recommendations. */
    async failStaleAudits(websiteId, { cutoff, summary }) {
      return db.run(
        "UPDATE seo_audits SET status = 'failed', finished_at = ?, summary = ? WHERE website_id = ? AND status IN ('queued','running') AND started_at < ?",
        [now(), summary, websiteId, cutoff]);
    },
    /** Phase 3 Step 4W.2 — observability only. The specialist pipeline's conflicts/skipped/errors diagnostics
     *  (server/seo/orchestrator.js, server/seo/specialistRecommendationConverter.js) are only known once
     *  runOnPageSpecialistIntegration() finishes, which happens AFTER finishAudit() has already committed
     *  this audit as 'complete' (see server/seo/jobs.js) — so this is a second, narrowly-scoped single-column
     *  write, not a duplicate of finishAudit()'s own fields, and never touches status/score/finished_at. */
    async setSpecialistDiagnostics(id, diagnostics) {
      await db.run('UPDATE seo_audits SET specialist_diagnostics = ? WHERE id = ?', [JSON.stringify(diagnostics), id]);
    },
    async getAudit(id) { return audit((await db.all('SELECT * FROM seo_audits WHERE id = ?', [id]))[0]); },
    async latestAudit(websiteId) { return audit((await db.all('SELECT * FROM seo_audits WHERE website_id = ? ORDER BY id DESC LIMIT 1', [websiteId]))[0]); },
    async previousCompleteAudit(websiteId, excludeAuditId) {
      return audit((await db.all("SELECT * FROM seo_audits WHERE website_id = ? AND status = 'complete' AND id <> ? ORDER BY id DESC LIMIT 1", [websiteId, excludeAuditId]))[0]);
    },
    async listAudits(websiteId, limit = 20) { return (await db.all('SELECT * FROM seo_audits WHERE website_id = ? ORDER BY id DESC LIMIT ?', [websiteId, limit])).map(audit); },

    /* SEO issues (findings from one audit) */
    async createIssues(websiteId, auditId, issues) {
      const at = now();
      for (const it of issues) {
        await db.run(
          'INSERT INTO seo_issues (website_id,audit_id,page_id,type,severity,status,detail,recommendation,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
          [websiteId, auditId, it.pageId ?? null, it.type, it.severity, 'open', it.detail ?? null, it.recommendation ?? null, at, at]);
      }
    },
    async listIssues({ websiteId, auditId, severity, status, type, pageId, limit = 200, offset = 0 } = {}) {
      const clauses = [], params = [];
      if (websiteId) { clauses.push('website_id = ?'); params.push(websiteId); }
      if (auditId) { clauses.push('audit_id = ?'); params.push(auditId); }
      if (severity) { clauses.push('severity = ?'); params.push(severity); }
      if (status) { clauses.push('status = ?'); params.push(status); }
      if (type) { clauses.push('type LIKE ?'); params.push(`%${type}%`); }
      if (pageId) { clauses.push('page_id = ?'); params.push(pageId); }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const rows = await db.all(`SELECT * FROM seo_issues ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
      return rows.map(seoIssue);
    },
    async issueCountsBySeverity(auditId) {
      const out = { total: 0, critical: 0, warning: 0, info: 0 };
      for (const r of await db.all('SELECT severity, COUNT(*) AS n FROM seo_issues WHERE audit_id = ? GROUP BY severity', [auditId])) { out[r.severity] = Number(r.n); out.total += Number(r.n); }
      return out;
    },
    async getIssue(id) { return seoIssue((await db.all('SELECT * FROM seo_issues WHERE id = ?', [id]))[0]); },

    /* internal-link graph edges discovered by one crawl */
    async createLinks(websiteId, auditId, links) {
      const at = now();
      for (const l of links) {
        await db.run(
          'INSERT INTO page_links (website_id,audit_id,from_page_id,to_url,to_page_id,anchor_text,is_internal,created_at) VALUES (?,?,?,?,?,?,?,?)',
          [websiteId, auditId, l.fromPageId, l.toUrl, l.toPageId ?? null, (l.anchorText || '').slice(0, 200), l.isInternal ? 1 : 0, at]);
      }
    },

    /* AI recommendations — always start 'pending'; never applied without an explicit approve + apply call */
    /** The ONE place every recommendation (the LLM path and the specialist path) is created. For a title or description recommendation it
     *  also records `base_value`: the site's own value of that field, read from the content row right now — the same stored, sanitized
     *  value Apply later compares against, so no normalization is involved. It is NOT `current_value`, which is whatever the crawler saw
     *  (on a static deployment that is build-time HTML, not the CMS). No content row, no such field, or any other type: NULL = no guard. */
    async createRecommendation({ websiteId, issueId, pageId, type, currentValue, proposedValue, reasoning, aiProvider, aiModel }) {
      const at = now();
      let baseValue = null;
      if (type === 'title' || type === 'description') {
        const live = (await this.getContent())?.data?.seo?.[type];
        if (typeof live === 'string') baseValue = live;
      }
      const id = await db.insert(
        'INSERT INTO seo_recommendations (website_id,issue_id,page_id,type,current_value,base_value,proposed_value,reasoning,ai_provider,ai_model,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,\'pending\',?)',
        [websiteId, issueId, pageId ?? null, type, currentValue ?? null, baseValue, proposedValue ?? null, reasoning ?? null, aiProvider ?? null, aiModel ?? null, at]);
      return this.getRecommendation(id);
    },
    async getRecommendation(id) { return recommendation((await db.all('SELECT * FROM seo_recommendations WHERE id = ?', [id]))[0]); },
    async listRecommendations({ websiteId, issueId, status, limit = 200, offset = 0 } = {}) {
      const clauses = [], params = [];
      if (websiteId) { clauses.push('website_id = ?'); params.push(websiteId); }
      if (issueId) { clauses.push('issue_id = ?'); params.push(issueId); }
      if (status) { clauses.push('status = ?'); params.push(status); }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const rows = await db.all(`SELECT * FROM seo_recommendations ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
      return rows.map(recommendation);
    },
    /** Phase 3 Step 4S — the cross-audit identity for a specialist recommendation's logical target.
     *  issue_id is audit-local and never stable across audits (a fresh row every scan — see createIssues()
     *  above), but page_id IS stable for the same (website_id, url) because pages are upserted in place
     *  (see upsertPage()). (website_id, page_id, type) is therefore the one combination that correctly
     *  identifies "the same logical recommendation target" whether it was found in this audit or an earlier
     *  one. `ai_provider = 'specialist-agent'` scopes this strictly to the specialist path — see
     *  specialistRecommendationConverter.js, which is the only writer of that exact literal; a real LLM
     *  provider name (e.g. 'anthropic') can never match, so an LLM-sourced recommendation for the same
     *  page/type is structurally invisible to this lookup and is never read, skipped, or altered by it.
     *  Returns only the single most recent matching row (if any) — the caller decides what today's status
     *  (and, if applied, verified_status) implies about creating a new one. */
    async findLatestSpecialistRecommendation({ websiteId, pageId, type }) {
      return recommendation((await db.all(
        "SELECT * FROM seo_recommendations WHERE website_id = ? AND page_id = ? AND type = ? AND ai_provider = 'specialist-agent' ORDER BY id DESC LIMIT 1",
        [websiteId, pageId, type]))[0]);
    },
    async setRecommendationStatus(id, status, { reviewedBy, applied } = {}) {
      const at = now();
      await db.run(
        `UPDATE seo_recommendations SET status = ?${reviewedBy !== undefined ? ', reviewed_at = ?, reviewed_by = ?' : ''}${applied ? ', applied_at = ?' : ''} WHERE id = ?`,
        [status, ...(reviewedBy !== undefined ? [at, reviewedBy] : []), ...(applied ? [at] : []), id]);
      return this.getRecommendation(id);
    },
    /** The production status-transition API (setRecommendationStatus above stays the unguarded setter). Only the four
     *  pairs in RECOMMENDATION_TRANSITIONS are accepted — anything else throws before any SQL runs. The UPDATE also
     *  requires the row to still be in `from`, so when several requests all read the same status, exactly one changes
     *  the row (and owns its reviewer and applied-at metadata) and the rest match nothing. Resolves to the updated
     *  recommendation, or null if the row was no longer in `from` (or doesn't exist). */
    async transitionRecommendation(id, { from, to, reviewedBy, applied } = {}) {
      if (!RECOMMENDATION_TRANSITIONS.has(`${from}>${to}`)) throw new Error(`Invalid recommendation transition: ${from} -> ${to}`);
      const at = now();
      const changed = await db.run(
        `UPDATE seo_recommendations SET status = ?${reviewedBy !== undefined ? ', reviewed_at = ?, reviewed_by = ?' : ''}${applied ? ', applied_at = ?' : ''} WHERE id = ? AND status = ?`,
        [to, ...(reviewedBy !== undefined ? [at, reviewedBy] : []), ...(applied ? [at] : []), id, from]);
      return changed > 0 ? this.getRecommendation(id) : null;
    },

    /* Phase 3 Step 2: recommendation-level verification — read/analysis only, never touches content or
       lifecycle `status`. See server/seo/jobs.js's verifyAppliedRecommendations() for the decision logic. */
    async listUnverifiedApplied(websiteId) {
      return (await db.all("SELECT * FROM seo_recommendations WHERE website_id = ? AND status = 'applied' AND verified_status IS NULL ORDER BY id", [websiteId])).map(recommendation);
    },
    /** Records a verification outcome exactly once: the `AND verified_status IS NULL` guard is an atomic
     *  compare-and-swap (same idiom as claimAudit()/createAuditIfNoneActive() above), so a recommendation
     *  that somehow got queued for verification twice (e.g. overlapping scans) is never overwritten a second
     *  time — repeated verification attempts can't corrupt or flip an already-recorded result. */
    async setRecommendationVerification(id, { verifiedStatus, verifiedAuditId }) {
      await db.run(
        "UPDATE seo_recommendations SET verified_status = ?, verified_at = ?, verified_audit_id = ? WHERE id = ? AND verified_status IS NULL",
        [verifiedStatus, now(), verifiedAuditId ?? null, id]);
      return this.getRecommendation(id);
    },
  };
}
