// Emergency access: npm run reset-password -- you@example.com "a-new-long-password"
// Runs on the server machine only (needs the same environment/database as the site). Signs the user out everywhere.
import { createStore } from './db.js';
import { hashPassword, passwordProblem } from './auth.js';

try { process.loadEnvFile(); } catch { /* environment variables only */ }
const [email, password] = process.argv.slice(2);
if (!email || !password) { console.error('Usage: npm run reset-password -- <email> "<new password>"'); process.exit(1); }
const problem = passwordProblem(password, email);
if (problem) { console.error(problem); process.exit(1); }

const store = await createStore();
const user = await store.userByEmail(email.trim().toLowerCase());
if (!user) { console.error(`No user with the email ${email}.`); await store.close(); process.exit(1); }
await store.updateUser(user.id, { passwordHash: await hashPassword(password) });
await store.deleteUserSessions(user.id);
console.log(`Password reset for ${user.email} (${user.role}). All their sessions were ended.`);
await store.close();
process.exit(0);
