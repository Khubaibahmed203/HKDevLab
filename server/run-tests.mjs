// `npm test` — runs the repository's whole test suite and says plainly whether it passed.
//
// Every server/test-*.mjs runs one after another in alphabetical order, each in its own `node` process started from the repository root (the
// procedure the suite has always been run with). Nothing a file prints is thrown away: its stdout, stderr, exit code and duration are saved to a
// results directory, and everything a problem file printed is echoed under its result line.
//
// The command exits 1, and names the file and the reason, if ANY file
//   - exits non-zero, is killed by a signal, cannot be run to completion, or does not finish within the timeout;
//   - prints no summary line (every test file ends with "N passed, M failed");
//   - reports a failed check; or
//   - reports no passed check at all (a file that asserts nothing proves nothing).
// Totals count only the files that produced a summary, and the number that did not is printed next to them, so a crashed file can never be
// mistaken for a smaller suite.
import { readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const TEST_TIMEOUT_MS = 300_000;     // per file: the slowest takes well under a minute, and a hung file must not hang the run
const MAX_BUFFER = 128 * 1024 * 1024;
const ECHO_STDOUT_LINES = 100;              // how much of a problem file's stdout is echoed (all of it is saved), besides every FAIL line
const ECHO_FAIL_LINES = 50;

const here = dirname(fileURLToPath(import.meta.url));   // .../server
const root = resolve(here, '..');                       // the repository root: the working directory the tests have always run from

/** The file's own result: the LAST line that is exactly "N passed, M failed". null when there is none. */
export function parseSummary(stdout) {
  let found = null;
  for (const m of String(stdout || '').matchAll(/^[ \t]*(\d+) passed, (\d+) failed[ \t\r]*$/gm)) found = { passed: Number(m[1]), failed: Number(m[2]) };
  return found;
}

/** Turns what spawnSync returned into a verdict: status is 'ok', or the reason the file does not count as passing. */
export function judge(r, summary, timeoutMs = TEST_TIMEOUT_MS) {
  if (r.error) return r.error.code === 'ETIMEDOUT'
    ? { status: 'TIMEOUT', reason: `did not finish within ${timeoutMs / 1000}s and was stopped` }
    : { status: 'ERROR', reason: `could not be run to completion (${r.error.code || r.error.message})` };
  if (r.signal) return { status: 'KILLED', reason: `terminated by signal ${r.signal}` };
  if (!summary) return { status: 'NOSUMMARY', reason: `printed no "N passed, M failed" summary line (exit code ${r.status})` };
  if (summary.failed > 0) return { status: 'FAILED', reason: `${summary.failed} check(s) failed (exit code ${r.status})` };
  if (r.status !== 0) return { status: 'EXIT', reason: `exit code ${r.status} although its summary reports no failure` };
  if (summary.passed === 0) return { status: 'NOCHECKS', reason: 'its summary reports no passed check' };
  return { status: 'ok', reason: '' };
}

/** Runs one test file in its own process from `cwd` and keeps everything it produced. */
export function runFile(file, { cwd = root, env = process.env, timeoutMs = TEST_TIMEOUT_MS } = {}) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [`server/${file}`], { cwd, env, encoding: 'utf8', timeout: timeoutMs, maxBuffer: MAX_BUFFER });
  const durationMs = Date.now() - t0;
  const stdout = r.stdout || '', stderr = r.stderr || '';
  const summary = parseSummary(stdout);
  return {
    file, ...judge(r, summary, timeoutMs), exit: r.status, signal: r.signal || null,
    spawnError: r.error ? { code: r.error.code || null, message: r.error.message } : null,
    passed: summary ? summary.passed : null, failed: summary ? summary.failed : null, durationMs, stdout, stderr,
  };
}

const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`;
const lines = (text) => text.replace(/\s+$/, '').split('\n');

/** Runs the suite found in `dir` and returns the process exit code (0 only when every file is ok). */
export function main({ dir = here, cwd = root, resultsDir, timeoutMs = TEST_TIMEOUT_MS } = {}) {
  const files = readdirSync(dir).filter((f) => /^test-.*\.mjs$/.test(f)).sort();
  const out = resultsDir || (process.env.TEST_RESULTS_DIR ? resolve(process.env.TEST_RESULTS_DIR) : join(tmpdir(), `hkdevlab-test-${new Date().toISOString().replace(/[:.]/g, '-')}`));
  if (!files.length) { console.log(`RESULT: FAIL - no test-*.mjs files found in ${dir}`); return 1; }

  // The tests use SQLite and an in-memory PostgreSQL emulator and clear DATABASE_URL themselves; a DATABASE_URL exported in the shell is
  // taken away from them anyway, so a run can never be pointed at a real database by accident.
  const env = { ...process.env };
  const removed = Object.keys(env).filter((k) => k.toUpperCase() === 'DATABASE_URL');
  for (const k of removed) delete env[k];

  console.log(`npm test - ${files.length} test file(s), one at a time, from ${cwd}`);
  console.log(`results (stdout, stderr, exit code and duration of every file): ${out}`);
  if (removed.length) console.log('note: DATABASE_URL is set in this shell; it was removed from the test processes');
  console.log('');

  let saveError = null;
  const save = (rec) => {
    try {
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, `${rec.file}.stdout`), rec.stdout);
      writeFileSync(join(out, `${rec.file}.stderr`), rec.stderr);
      const { stdout, stderr, ...meta } = rec;
      writeFileSync(join(out, `${rec.file}.meta.json`), JSON.stringify(meta, null, 2));
    } catch (err) { saveError ||= err; }
  };
  const echo = (rec) => {
    const so = rec.stdout.trim() ? lines(rec.stdout) : [], se = rec.stderr.trim() ? lines(rec.stderr) : [];
    const fails = so.filter((l) => l.startsWith('FAIL'));
    console.log(`  | everything ${rec.file} printed (exit code ${rec.exit ?? 'none'}${rec.signal ? `, signal ${rec.signal}` : ''}${rec.spawnError ? `, ${rec.spawnError.code || rec.spawnError.message}` : ''})`);
    console.log(`  | stderr:${se.length ? '' : ' (empty)'}`);
    for (const l of se) console.log(`  |   ${l}`);
    if (fails.length) {
      console.log(`  | FAIL lines (${fails.length}):`);
      for (const l of fails.slice(0, ECHO_FAIL_LINES)) console.log(`  |   ${l}`);
      if (fails.length > ECHO_FAIL_LINES) console.log(`  |   ... ${fails.length - ECHO_FAIL_LINES} more in the saved stdout`);
    }
    const tail = so.slice(-ECHO_STDOUT_LINES);
    console.log(`  | stdout:${so.length ? ` (last ${tail.length} of ${so.length} lines; the whole file is saved)` : ' (empty)'}`);
    for (const l of tail) console.log(`  |   ${l}`);
    console.log('  |');
  };

  const problems = [];
  let passed = 0, failed = 0, withSummary = 0;
  for (const file of files) {
    const rec = runFile(file, { cwd, env, timeoutMs });
    save(rec);
    if (rec.passed !== null) { withSummary++; passed += rec.passed; failed += rec.failed; }
    const checks = rec.passed === null ? 'no summary' : `${rec.passed} passed, ${rec.failed} failed`;
    console.log(`${rec.status === 'ok' ? 'ok      ' : rec.status.padEnd(8)} ${file}  ${rec.status === 'ok' ? checks : `${rec.reason}${rec.passed === null ? '' : ` [${checks}]`}`}  [${seconds(rec.durationMs)}]`);
    if (rec.status !== 'ok') { problems.push(rec); echo(rec); }
  }

  console.log('');
  console.log(`files: ${files.length} attempted, ${files.length - problems.length} ok, ${problems.length} with problems`);
  console.log(`checks: ${passed} passed, ${failed} failed - counted from the ${withSummary} file(s) that printed a summary${withSummary === files.length ? '' : `; ${files.length - withSummary} file(s) printed none, so their checks are NOT counted`}`);
  for (const p of problems) console.log(`PROBLEM ${p.file}: ${p.status} - ${p.reason}`);
  if (saveError) console.log(`warning: could not save the full output to ${out} (${saveError.message}); problem files were still echoed above`);
  console.log(problems.length
    ? `RESULT: FAIL - ${problems.length} of ${files.length} file(s) did not pass; this is not a clean run. Full output of every file: ${out}`
    : `RESULT: PASS - all ${files.length} files ok. Full output of every file: ${out}`);
  return problems.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = main();
