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

async function pgAdapter(poolOrUrl) {
  let pool = poolOrUrl;
  if (typeof poolOrUrl === 'string') {
    const { default: pg } = await import('pg');
    const local = /localhost|127\.0\.0\.1/.test(poolOrUrl);
    pool = new pg.Pool({ connectionString: poolOrUrl, ssl: local || process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false }, max: 5 });
  }
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
  ].join(';\n'));
  // databases created before Google sign-in existed lack this column
  try { await db.exec(`ALTER TABLE users ADD COLUMN ${db.kind === 'postgres' ? 'IF NOT EXISTS ' : ''}google_sub TEXT`); } catch { /* already there */ }

  const enq = (r) => ({ ...r, id: Number(r.id), email_sent: !!Number(r.email_sent) });
  const website = (r) => r && { ...r, id: Number(r.id) };
  const page = (r) => r && { ...r, id: Number(r.id), website_id: Number(r.website_id) };
  const audit = (r) => r && { ...r, id: Number(r.id), website_id: Number(r.website_id), score: r.score == null ? null : Number(r.score) };
  const seoIssue = (r) => r && { ...r, id: Number(r.id), website_id: Number(r.website_id), audit_id: Number(r.audit_id), page_id: r.page_id == null ? null : Number(r.page_id) };
  const user = (r) => r && {
    id: Number(r.id), email: r.email, name: r.name, role: r.role, created_at: r.created_at, last_login_at: r.last_login_at,
    hasPassword: String(r.password_hash || '').startsWith('scrypt:'), googleLinked: !!r.google_sub,
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
    async rateHit(key) {
      const t = Date.now();
      await db.run('INSERT INTO rate_events (k, ts) VALUES (?,?)', [key, t]);
      if (Math.random() < 0.05) await db.run('DELETE FROM rate_events WHERE ts < ?', [t - 3_600_000]);     // housekeeping
    },
    async rateCount(key, windowMs) { return Number((await db.all('SELECT COUNT(*) AS n FROM rate_events WHERE k = ? AND ts > ?', [key, Date.now() - windowMs]))[0].n); },
    async rateClear(key) { await db.run('DELETE FROM rate_events WHERE k = ?', [key]); },

    /* site content (+ version history) */
    async getContent() {
      const r = (await db.all("SELECT value, updated_at, updated_by FROM content WHERE key = 'site'"))[0];
      return r ? { data: JSON.parse(r.value), updatedAt: r.updated_at, updatedBy: r.updated_by } : null;
    },
    async saveContent(data, userEmail, note) {
      const value = JSON.stringify(data), at = now();
      if ((await db.run("UPDATE content SET value = ?, updated_at = ?, updated_by = ? WHERE key = 'site'", [value, at, userEmail])) === 0) {
        try { await db.run("INSERT INTO content (key,value,updated_at,updated_by) VALUES ('site',?,?,?)", [value, at, userEmail]); }
        catch { await db.run("UPDATE content SET value = ?, updated_at = ?, updated_by = ? WHERE key = 'site'", [value, at, userEmail]); }   // lost a race to another server
      }
      await db.insert('INSERT INTO content_versions (created_at,user_email,note,value) VALUES (?,?,?,?)', [at, userEmail, note || null, value]);
      await db.run(`DELETE FROM content_versions WHERE id NOT IN (SELECT id FROM (SELECT id FROM content_versions ORDER BY id DESC LIMIT ${MAX_VERSIONS}) keep)`);
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

    /* pages (one crawlable URL per website — Phase 1 only ever writes the homepage) */
    async upsertPage({ websiteId, url, title, description, statusCode }) {
      const at = now();
      const existing = (await db.all('SELECT id FROM pages WHERE website_id = ? AND url = ?', [websiteId, url]))[0];
      if (existing) {
        await db.run('UPDATE pages SET title = ?, description = ?, status_code = ?, last_crawled_at = ?, updated_at = ? WHERE id = ?',
          [title || null, description || null, statusCode ?? null, at, at, existing.id]);
        return Number(existing.id);
      }
      return db.insert('INSERT INTO pages (website_id,url,title,description,status_code,last_crawled_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
        [websiteId, url, title || null, description || null, statusCode ?? null, at, at, at]);
    },
    async listPages(websiteId) { return (await db.all('SELECT * FROM pages WHERE website_id = ? ORDER BY id', [websiteId])).map(page); },

    /* SEO audits (one row per SCAN→ANALYZE run) */
    async createAudit(websiteId) {
      const at = now();
      const id = await db.insert("INSERT INTO seo_audits (website_id,started_at,status) VALUES (?,?,'running')", [websiteId, at]);
      return { id, website_id: websiteId, started_at: at, finished_at: null, score: null, status: 'running', summary: null };
    },
    async finishAudit(id, { score, status, summary }) {
      await db.run('UPDATE seo_audits SET finished_at = ?, score = ?, status = ?, summary = ? WHERE id = ?', [now(), score ?? null, status, summary || null, id]);
    },
    async getAudit(id) { return audit((await db.all('SELECT * FROM seo_audits WHERE id = ?', [id]))[0]); },
    async latestAudit(websiteId) { return audit((await db.all('SELECT * FROM seo_audits WHERE website_id = ? ORDER BY id DESC LIMIT 1', [websiteId]))[0]); },

    /* SEO issues (findings from one audit) */
    async createIssues(websiteId, auditId, issues) {
      const at = now();
      for (const it of issues) {
        await db.run(
          'INSERT INTO seo_issues (website_id,audit_id,page_id,type,severity,status,detail,recommendation,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
          [websiteId, auditId, it.pageId ?? null, it.type, it.severity, 'open', it.detail ?? null, it.recommendation ?? null, at, at]);
      }
    },
    async listIssues({ websiteId, auditId, severity, status, limit = 200, offset = 0 } = {}) {
      const clauses = [], params = [];
      if (websiteId) { clauses.push('website_id = ?'); params.push(websiteId); }
      if (auditId) { clauses.push('audit_id = ?'); params.push(auditId); }
      if (severity) { clauses.push('severity = ?'); params.push(severity); }
      if (status) { clauses.push('status = ?'); params.push(status); }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const rows = await db.all(`SELECT * FROM seo_issues ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
      return rows.map(seoIssue);
    },
  };
}
