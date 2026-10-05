// The capture script must never fail silently, never overwrite a good screenshot with a bad one, and never be fooled by a blank / wall page.
// Serves a few small pages from this process and runs the real script against them (needs Chrome / Edge installed).   Run: node scripts/test-capture-previews.mjs
import http from 'node:http';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { (c ? pass++ : fail++); console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : '  ' + x}`); };

const page = (body, title = 'Test') => `<!doctype html><title>${title}</title><body style="margin:0;font:48px sans-serif;background:linear-gradient(120deg,#12304f,#7a1fa2,#e0742a);color:#fff;height:100vh;display:grid;place-items:center">${body}`;
let port;
const srv = http.createServer((req, res) => {
  const send = (code, html) => { res.writeHead(code, { 'content-type': 'text/html' }); res.end(html); };
  if (req.url === '/api/content') {
    const u = (p) => `http://127.0.0.1:${port}${p}`;
    const live = (name, liveUrl) => ({ name, meta: 'm', featured: true, published: true, kind: 'live', description: 'd', technologies: [], liveUrl, githubUrl: '' });
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ work: { items: [live('Good page', u('/good')), live('Blank page', u('/blank')), live('Wall page', u('/wall')), live('Server error', u('/err')), live('Missing page', u('/missing')), live('Dead domain', 'https://no-such-host-hkdevlab-test.invalid/'), live('Kept page', u('/kept')), { name: 'Sample mock', kind: 'hero', url: 'x.example' }, { name: 'Draft', kind: 'live', published: false, liveUrl: u('/draft') }] } }));
  }
  if (req.url === '/good') return send(200, page('<h1>Hello from a good landing page</h1>'));
  if (req.url === '/blank') return send(200, '<!doctype html><title>x</title><body style="margin:0;background:#101010">');
  if (req.url === '/wall') return send(200, page('<p>Checking your browser before accessing the site.</p>', 'Just a moment...'));
  if (req.url === '/err') return send(500, 'boom');
  if (req.url === '/kept') return send(200, '<!doctype html><body style="background:#101010">');           // blank now — but a screenshot exists from before
  return send(404, 'nope');
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
port = srv.address().port;

const dir = join(ROOT, 'public/assets/projects');
const slug = (p) => `127-0-0-1-${port}-${p}-preview.webp`;
const keep = join(dir, slug('kept'));
mkdirSync(dir, { recursive: true });
writeFileSync(keep, Buffer.from('RIFF....WEBPprevious-good-screenshot'));
const run = await new Promise((r) => execFile('node', ['scripts/capture-project-previews.mjs', '--from', `http://127.0.0.1:${port}`], { cwd: ROOT, encoding: 'utf8', timeout: 240000 }, (err, stdout) => r({ status: err ? err.code : 0, stdout })));
console.log(run.stdout);
const out = run.stdout;
ok('exit code is 1 when something failed', run.status === 1, String(run.status));
ok('the good page is captured', /✓ Good page/.test(out) && existsSync(join(dir, slug('good'))));
ok('a blank page is reported, not saved', /✗ Blank page — the page looks blank/.test(out) && !existsSync(join(dir, slug('blank'))), out);
ok('a bot-protection / wall page is reported, not saved', /✗ Wall page — an access \/ bot-protection page is in the way \(not bypassed\)/.test(out) && !existsSync(join(dir, slug('wall'))));
ok('an HTTP error is reported with its status', /✗ Server error — URL unavailable — HTTP 500/.test(out));
ok('a missing page (404) is reported', /✗ Missing page — URL unavailable — HTTP 404/.test(out));
ok('an unreachable domain is reported plainly', /✗ Dead domain — URL unavailable — domain name not found/.test(out), out);
ok('a failed capture says the previous screenshot was kept — and it really is untouched', /✗ Kept page[^\n]*\n[^\n]*previous screenshot kept/.test(out) && readFileSync(keep).toString().includes('previous-good-screenshot'));
ok('sample mockups and drafts are not captured', !/Sample mock|Draft/.test(out));
ok('the summary names every failure', /1 captured, 6 failed: Blank page, Wall page, Server error, Missing page, Dead domain, Kept page/.test(out));
for (const p of ['good', 'blank', 'wall', 'kept']) rmSync(join(dir, slug(p)), { force: true });
srv.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
