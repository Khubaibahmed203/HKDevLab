// Phase 4 Hardening #10 — redirect SSRF protection.
// Before: fetchBounded() let fetch() follow redirects on its own (up to 20 hops, no validation), so an audited site — or anything able to change
// its responses — could answer ANY crawler request (a page, robots.txt, a sitemap) with a redirect to http://127.0.0.1/, a private network
// address or the cloud metadata address, and the server made that request. The audit reproduced it against loopback and an RFC 1918 address.
// Now fetchBounded() follows redirects itself, one explicit hop at a time (at most MAX_REDIRECTS = 10, all under the ONE original deadline),
// and every hop is checked by server/seo/ssrf.js BEFORE it is requested:
//   * only http: and https:, and never embedded credentials;
//   * a hop to the SAME host:port as the response that redirected is always allowed (the audited site, local development, these tests);
//   * a hop to ANOTHER host must be a public unicast destination: IP literals are judged as the URL parser normalized them (127.1, 2130706433,
//     0x7f.1, octal, IPv4-mapped IPv6 …), names must not be localhost / *.localhost / single-label / reserved internal, and every address the name
//     resolves to must be public — so ordinary http→https and apex↔www redirects, and any other public redirect, keep working.
// robots.txt, sitemaps and pages all reach the network through fetchBounded(), so all three inherit this with no change of their own.
//
// WHAT THIS DOES NOT PROVE — and the change does not claim: DNS rebinding. The name is resolved by the policy check and again, independently, by
// the HTTP client when it connects; nothing pins the connection to the checked address. The tests below make a fake "public" host name reachable
// on loopback by patching node:dns (policy-time and connect-time answers differ on purpose); that is a test harness, not a model of rebinding
// defence. Connection-time IP validation is out of scope for this change and remains a known limitation.
// Run: node server/test-seo-redirect-ssrf.mjs
import http from 'node:http';
import dns from 'node:dns';
import dnsp from 'node:dns/promises';
import { isIP } from 'node:net';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { (cond ? pass++ : fail++); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };
const watchdog = setTimeout(() => { console.log('FAIL  watchdog: the test did not finish in time'); process.exit(1); }, 170_000);
watchdog.unref();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const H = await import(new URL('./seo/http.js', import.meta.url).href);
const S = await import(new URL('./seo/ssrf.js', import.meta.url).href);
const { crawlWebsite } = await import(new URL('./seo/crawler.js', import.meta.url).href);
const { fetchRobots } = await import(new URL('./seo/robots.js', import.meta.url).href);
const { discoverSitemaps } = await import(new URL('./seo/sitemap.js', import.meta.url).href);
const { analyzePages } = await import(new URL('./seo/pageAnalyzer.js', import.meta.url).href);
const src = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

/* ═════════ 1. isPublicAddress / isPublicHostname ═════════ */
{
  const rows = (name, list, expected) => { const wrong = list.filter((a) => S.isPublicAddress(a) !== expected); ok(`1. ${name} (${list.length}): ${expected ? 'public' : 'refused'}`, wrong.length === 0, `wrong: ${wrong.join(' ')}`); };
  rows('ordinary public IPv4 addresses', ['8.8.8.8', '1.1.1.1', '93.184.216.34', '1.0.0.1', '151.101.1.1', '104.16.0.1', '172.15.255.255', '172.32.0.1', '100.63.255.255', '100.128.0.1', '169.253.255.255', '169.255.0.1', '126.255.255.255', '128.0.0.1', '192.0.1.1', '192.169.0.1', '198.17.255.255', '198.20.0.1', '223.255.255.254'], true);
  rows('loopback 127.0.0.0/8', ['127.0.0.1', '127.0.0.0', '127.255.255.255', '127.1.2.3'], false);
  rows('private 10.0.0.0/8', ['10.0.0.0', '10.0.0.1', '10.255.255.255'], false);
  rows('private 172.16.0.0/12', ['172.16.0.0', '172.16.0.1', '172.20.1.1', '172.31.255.255'], false);
  rows('private 192.168.0.0/16', ['192.168.0.0', '192.168.0.1', '192.168.255.255'], false);
  rows('link-local 169.254.0.0/16 (cloud metadata 169.254.169.254)', ['169.254.0.0', '169.254.169.254', '169.254.255.255'], false);
  rows('carrier-grade NAT 100.64.0.0/10', ['100.64.0.0', '100.64.0.1', '100.127.255.255'], false);
  rows('"this network" 0.0.0.0/8', ['0.0.0.0', '0.0.0.1', '0.255.255.255'], false);
  rows('multicast 224.0.0.0/4', ['224.0.0.0', '224.0.0.1', '239.255.255.255'], false);
  rows('reserved 240.0.0.0/4 and broadcast', ['240.0.0.0', '240.0.0.1', '255.255.255.254', '255.255.255.255'], false);
  rows('special-use: protocol assignments, TEST-NET-1/2/3, 6to4 relay, benchmarking', ['192.0.0.0', '192.0.0.255', '192.0.2.0', '192.0.2.255', '198.51.100.1', '203.0.113.1', '192.88.99.1', '198.18.0.0', '198.19.255.255'], false);
  rows('public IPv6 (global unicast 2000::/3)', ['2606:4700:4700::1111', '2001:4860:4860::8888', '2a00:1450:4001:81a::200e', '2000::1', '2400:cb00::1', '3ffe::1'], true);
  rows('public IPv6 written with a dotted IPv4 tail (the form a resolver may hand back)', ['2606:4700:4700::1.1.1.1', '2001:4860:4860:0:0:0:8.8.8.8'], true);
  rows('IPv6 loopback and unspecified', ['::1', '::', '0:0:0:0:0:0:0:1', '0000:0000:0000:0000:0000:0000:0000:0000'], false);
  rows('IPv4-mapped IPv6 — every one, public or not', ['::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:8.8.8.8', '::ffff:808:808', '0:0:0:0:0:ffff:7f00:1', '::FFFF:169.254.169.254'], false);
  rows('IPv4-compatible and NAT64 IPv6 (embedding an IPv4 address)', ['::127.0.0.1', '::7f00:1', '::8.8.8.8', '64:ff9b::7f00:1', '64:ff9b::808:808', '64:ff9b:1::1'], false);
  rows('IPv6 unique-local fc00::/7', ['fc00::1', 'fd00::1', 'fd00:ec2::254', 'fdff:ffff::1'], false);
  rows('IPv6 link-local fe80::/10 (and deprecated site-local)', ['fe80::1', 'febf::1', 'fe80::1%eth0', 'fec0::1'], false);
  rows('IPv6 multicast ff00::/8', ['ff00::', 'ff02::1', 'ff05::2', 'ffff::1'], false);
  rows('IPv6 special-purpose inside and around 2000::/3', ['2001::1', '2001:1::1', '2001:db8::1', '2001:db8:ffff::1', '2002::1', '2002:7f00:1::1', '3fff::1', '3fff:fff:ffff::1', '100::1', '4000::1', 'e000::1'], false);
  rows('text that is not an address at all', ['', 'localhost', 'example.com', '1.2.3', '256.1.1.1', '1.2.3.4.5', '2130706433', '0x7f.1', '::g', '1::2::3', '12345::1', 'http://8.8.8.8', null, undefined], false);
  ok('1. bracketed IPv6 is accepted as written in a URL', S.isPublicAddress('[2606:4700:4700::1111]') === true && S.isPublicAddress('[::1]') === false);

  const names = (list, expected) => { const wrong = list.filter((n) => S.isPublicHostname(n) !== expected); ok(`1. host names (${list.length}): ${expected ? 'public' : 'refused'}`, wrong.length === 0, `wrong: ${wrong.join(' ')}`); };
  names(['example.com', 'www.example.com', 'a.b.example.co.uk', 'xn--bcher-kva.example', 'example.com.', 'pub.test'], true);
  names(['localhost', 'LOCALHOST', 'Localhost', 'localhost.', 'localhost..', 'foo.localhost', 'a.b.localhost.', 'FOO.LocalHost'], false);
  names(['intranet', 'metadata', 'redis', 'kubernetes', 'host.', ''], false);
  names(['printer.local', 'x.localdomain', 'svc.internal', 'a.b.internal.', 'router.home.arpa', 'local', 'internal'], false);
  names(['mylocalhost.com', 'localhost.example.com', 'internal.example.com', 'notlocal.example', 'locally.example'], true);
}

/* ═════════ 2. checkRedirectTarget: the policy, with a stub resolver ═════════ */
{
  let calls = [];
  const stub = async (host) => {
    calls.push(host);
    if (host === 'rebind.test') return [{ address: '10.1.2.3', family: 4 }];
    if (host === 'mixed.test') return [{ address: '8.8.8.8', family: 4 }, { address: '192.168.0.9', family: 4 }];
    if (host === 'mixed2.test') return [{ address: '192.168.0.9', family: 4 }, { address: '8.8.8.8', family: 4 }];
    if (host === 'mapped.test') return [{ address: '::ffff:127.0.0.1', family: 6 }];
    if (host === 'loop6.test') return [{ address: '::1', family: 6 }];
    if (host === 'meta.test') return [{ address: '169.254.169.254', family: 4 }];
    if (host === 'nx.test') throw Object.assign(new Error('queryA ENOTFOUND nx.test'), { code: 'ENOTFOUND' });
    if (host === 'empty.test') return [];
    if (host === 'v6.test') return [{ address: '2606:4700:4700::1111', family: 6 }];
    if (host === 'dual.test') return [{ address: '93.184.216.34', family: 4 }, { address: '2606:4700:4700::1111', family: 6 }];
    return [{ address: '93.184.216.34', family: 4 }];
  };
  const FROM = 'https://public.example/start';
  const decide = async (to, from = FROM, extra = {}) => { calls = []; const r = await S.checkRedirectTarget(new URL(to, from), new URL(from), { lookup: stub, ...extra }); return { ...r, lookups: [...calls] }; };
  const row = async (label, to, expected, from) => { const r = await decide(to, from); const got = r.ok ? 'allow' : r.reason; ok(`2. ${label}: ${expected === 'allow' ? 'allowed' : `blocked (${expected})`}`, got === expected, `${to} -> ${got}`); return r; };

  // the approved matrix
  const allow = [
    ['same host, http', 'http://public.example/next'], ['same host, https', 'https://public.example/next?q=1#f'], ['same host, other path', 'https://public.example/a/b/c'],
    ['same host, upper-case spelling', 'HTTPS://PUBLIC.EXAMPLE/x'], ['public external, http', 'http://other.example.net/'], ['public external, https', 'https://other.example.net/landing'],
    ['public external IPv4 literal', 'http://93.184.216.34/'], ['public external IPv6 literal', 'https://[2606:4700:4700::1111]/'], ['public host with a public IPv6 address', 'https://v6.test/'], ['public host with IPv4 and IPv6 addresses', 'https://dual.test/'],
    ['trailing-dot spelling of a public host', 'https://public.example./'],
  ];
  for (const [label, to] of allow) await row(label, to, 'allow');
  { const r = await row('apex to www', 'https://www.example.org/', 'allow', 'https://example.org/'); ok('2. …a hop to another host resolves the name (once, without the trailing dot rule disturbing it)', r.lookups.join() === 'www.example.org'); }
  await row('www to apex', 'https://example.org/', 'allow', 'https://www.example.org/');
  { const r = await decide('https://public.example./'); ok('2. a trailing-dot name is resolved without the dot', r.ok && r.lookups.join() === 'public.example', r.lookups.join()); }
  for (const [label, to, from] of [['local development: localhost to the same localhost:port', 'http://localhost:3000/b', 'http://localhost:3000/a'], ['same loopback address and port', 'http://127.0.0.1:3000/x', 'http://127.0.0.1:3000/'], ['same private host (an intranet site audited on purpose)', 'http://10.0.0.5/b', 'http://10.0.0.5/a'], ['same private host, http to https', 'https://10.0.0.5/b', 'http://10.0.0.5/a']])
    { const r = await row(label, to, 'allow', from); ok(`2. …${label}: no name resolution at all`, r.lookups.length === 0); }
  { const r = await decide('http://93.184.216.34/'); ok('2. an IP literal is judged on the address and never resolved', r.lookups.length === 0); }
  { const r = await decide('https://public.example/other'); ok('2. a same-host hop is never resolved', r.lookups.length === 0); }

  const block = [
    // IPv4 spellings of loopback — the URL parser normalizes every one of these to 127.0.0.1
    ['127.0.0.1', 'http://127.0.0.1/', 'non-public-address'], ['127.1 (short form)', 'http://127.1/', 'non-public-address'], ['2130706433 (decimal)', 'http://2130706433/', 'non-public-address'],
    ['0x7f000001 (hex)', 'http://0x7f000001/', 'non-public-address'], ['0x7f.1 (dotted hex)', 'http://0x7f.1/', 'non-public-address'], ['017700000001 (octal)', 'http://017700000001/', 'non-public-address'],
    ['0177.0.0.1 (dotted octal)', 'http://0177.0.0.1/', 'non-public-address'], ['127.000.000.001', 'http://127.000.000.001/', 'non-public-address'], ['127.0.0.1. (trailing dot)', 'http://127.0.0.1./', 'non-public-address'],
    ['127.255.255.254', 'http://127.255.255.254/', 'non-public-address'],
    ['fullwidth/circled digits that normalize to 127.0.0.1', 'http://①②⑦.0.0.1/', 'non-public-address'], ['ideographic full stops', 'http://127。0。0。1/', 'non-public-address'], ['percent-encoded digits', 'http://%31%32%37.0.0.1/', 'non-public-address'],
    ['0 (shorthand for 0.0.0.0)', 'http://0/', 'non-public-address'], ['0.0.0.0', 'http://0.0.0.0/', 'non-public-address'],
    // names
    ['localhost', 'http://localhost/', 'non-public-name'], ['LOCALHOST', 'http://LOCALHOST/', 'non-public-name'], ['localhost. (trailing dot)', 'http://localhost./', 'non-public-name'], ['foo.localhost', 'http://foo.localhost/', 'non-public-name'],
    ['a.b.localhost. (nested, trailing dot)', 'http://a.b.localhost./', 'non-public-name'], ['fullwidth letters that normalize to localhost', 'http://ｌｏｃａｌｈｏｓｔ/', 'non-public-name'],
    ['a single-label name', 'http://intranet/', 'non-public-name'], ['metadata (single label)', 'http://metadata/', 'non-public-name'], ['*.internal', 'http://api.internal/', 'non-public-name'], ['*.local', 'http://printer.local/', 'non-public-name'],
    ['*.localdomain', 'http://x.localdomain/', 'non-public-name'], ['*.home.arpa', 'http://nas.home.arpa/', 'non-public-name'], ['metadata.google.internal', 'http://metadata.google.internal/computeMetadata/v1/', 'non-public-name'],
    // IPv6
    ['::1', 'http://[::1]/', 'non-public-address'], ['IPv4-mapped loopback [::ffff:127.0.0.1]', 'http://[::ffff:127.0.0.1]/', 'non-public-address'], ['IPv4-mapped loopback [::ffff:7f00:1]', 'http://[::ffff:7f00:1]/', 'non-public-address'],
    ['IPv4-mapped public address (all mapped forms are refused)', 'http://[::ffff:8.8.8.8]/', 'non-public-address'], ['IPv4-mapped metadata address', 'http://[::ffff:169.254.169.254]/', 'non-public-address'],
    ['IPv4-compatible [::127.0.0.1]', 'http://[::127.0.0.1]/', 'non-public-address'], ['unspecified [::]', 'http://[::]/', 'non-public-address'], ['NAT64 embedding loopback', 'http://[64:ff9b::7f00:1]/', 'non-public-address'],
    ['unique-local fc00::/7', 'http://[fc00::1]/', 'non-public-address'], ['unique-local fd00::', 'http://[fd00::1]/', 'non-public-address'], ['the IPv6 metadata address fd00:ec2::254', 'http://[fd00:ec2::254]/', 'non-public-address'],
    ['link-local fe80::1', 'http://[fe80::1]/', 'non-public-address'], ['link-local febf::1', 'http://[febf::1]/', 'non-public-address'], ['multicast ff02::1', 'http://[ff02::1]/', 'non-public-address'], ['documentation 2001:db8::', 'http://[2001:db8::1]/', 'non-public-address'],
    ['6to4 embedding loopback', 'http://[2002:7f00:1::]/', 'non-public-address'], ['Teredo 2001::', 'http://[2001::1]/', 'non-public-address'],
    // IPv4 ranges
    ['10.0.0.1', 'http://10.0.0.1/', 'non-public-address'], ['10.255.255.255', 'http://10.255.255.255/', 'non-public-address'], ['172.16.0.1', 'http://172.16.0.1/', 'non-public-address'], ['172.31.255.254', 'http://172.31.255.254/', 'non-public-address'],
    ['192.168.0.1', 'http://192.168.0.1/', 'non-public-address'], ['192.168.255.255', 'http://192.168.255.255/', 'non-public-address'], ['169.254.169.254 (cloud metadata)', 'http://169.254.169.254/latest/meta-data/', 'non-public-address'],
    ['169.254.0.1', 'http://169.254.0.1/', 'non-public-address'], ['100.64.0.1 (CGNAT)', 'http://100.64.0.1/', 'non-public-address'], ['100.127.255.254', 'http://100.127.255.254/', 'non-public-address'],
    ['224.0.0.1 (multicast)', 'http://224.0.0.1/', 'non-public-address'], ['239.255.255.250', 'http://239.255.255.250/', 'non-public-address'], ['240.0.0.1 (reserved)', 'http://240.0.0.1/', 'non-public-address'], ['255.255.255.255', 'http://255.255.255.255/', 'non-public-address'],
    ['192.0.2.1 (TEST-NET-1)', 'http://192.0.2.1/', 'non-public-address'], ['198.18.0.1 (benchmarking)', 'http://198.18.0.1/', 'non-public-address'],
    // credentials
    ['credentials on another host', 'http://user:pass@other.example.net/', 'credentials'], ['a username only', 'http://user@other.example.net/', 'credentials'], ['a password only', 'http://:secret@other.example.net/', 'credentials'],
    ['credentials on the SAME host (still refused)', 'https://user:pass@public.example/', 'credentials'], ['the userinfo trick: a public name before @, loopback after', 'https://public.example@127.0.0.1/', 'credentials'],
    // schemes
    ['file:', 'file:///etc/passwd', 'scheme'], ['ftp:', 'ftp://public.example/', 'scheme'], ['gopher:', 'gopher://public.example:70/', 'scheme'], ['data:', 'data:text/html,hi', 'scheme'], ['javascript:', 'javascript:alert(1)', 'scheme'],
    ['ws:', 'ws://public.example/', 'scheme'], ['wss:', 'wss://public.example/', 'scheme'], ['blob:', 'blob:https://public.example/abc', 'scheme'], ['an upper-case FTP scheme', 'FTP://public.example/', 'scheme'],
    // names that RESOLVE somewhere non-public
    ['a public-looking name that resolves to 10.1.2.3', 'http://rebind.test/', 'resolves-non-public'], ['a name with a public AND a private address (public first)', 'http://mixed.test/', 'resolves-non-public'],
    ['a name with a private AND a public address (private first)', 'http://mixed2.test/', 'resolves-non-public'], ['a name that resolves to an IPv4-mapped loopback', 'http://mapped.test/', 'resolves-non-public'],
    ['a name that resolves to ::1', 'http://loop6.test/', 'resolves-non-public'], ['a name that resolves to the metadata address', 'http://meta.test/', 'resolves-non-public'],
    ['a name that does not resolve', 'http://nx.test/', 'unresolvable'], ['a name that resolves to nothing', 'http://empty.test/', 'unresolvable'],
  ];
  for (const [label, to, reason] of block) await row(label, to, reason);
  { const r = await row('a protocol-relative Location //127.0.0.1/x', '//127.0.0.1/x', 'non-public-address'); ok('2. …blocked without any resolution', r.lookups.length === 0); }
  for (const to of ['http://127.0.0.1/', 'http://localhost/', 'http://[::1]/', 'http://10.0.0.1/', 'http://user:pw@x.example/', 'file:///x']) { const r = await decide(to); ok(`2. a refused literal/name/scheme is never resolved (${to})`, !r.ok && r.lookups.length === 0, r.lookups.join()); }

  // the same-host exemption is not a bypass
  await row('public host to loopback is not "the same host"', 'http://127.0.0.1/', 'non-public-address', 'https://public.example/');
  await row('loopback to loopback on a DIFFERENT port', 'http://127.0.0.1:4000/', 'non-public-address', 'http://127.0.0.1:3000/');
  await row('localhost:3000 to localhost:3001', 'http://localhost:3001/', 'non-public-name', 'http://localhost:3000/');
  await row('localhost to 127.0.0.1 (same machine, different spelling)', 'http://127.0.0.1:3000/', 'non-public-address', 'http://localhost:3000/');
  await row('a public host to a private host that merely contains its name', 'http://public.example.internal/', 'non-public-name', 'https://public.example/');
  await row('a hop BACK to the loopback address the audit started on, from another host', 'http://127.0.0.1:3000/', 'non-public-address', 'https://other.example.net/');
  await row('a hop to the same host with another port is another host (resolved, public here)', 'http://public.example:8080/', 'allow', 'http://public.example/');
  await row('...and refused when that name resolves privately', 'http://rebind.test:8080/', 'resolves-non-public', 'http://rebind.test/');

  // the resolver is bounded by the caller's deadline
  { const never = () => new Promise(() => {}); const ac = new AbortController(); setTimeout(() => ac.abort(new Error('deadline')), 60);
    const t0 = Date.now(); let thrown = null; try { await S.checkRedirectTarget(new URL('http://hang.test/'), new URL(FROM), { lookup: never, signal: ac.signal }); } catch (e) { thrown = e; }
    ok('2. a resolver that never answers cannot outlive the deadline: the abort reason is thrown', thrown?.message === 'deadline' && Date.now() - t0 < 1000, String(thrown)); }
  { const ac = new AbortController(); ac.abort(new Error('already')); let thrown = null; try { await S.checkRedirectTarget(new URL('http://x.test/'), new URL(FROM), { lookup: stub, signal: ac.signal }); } catch (e) { thrown = e; }
    ok('2. …and an already-expired deadline throws before resolving', thrown?.message === 'already', String(thrown)); }
  { let thrown = null; try { await S.checkRedirectTarget(new URL('http://x.test/'), new URL(FROM), { lookup: () => { throw new Error('sync boom'); } }); } catch (e) { thrown = e; }
    ok('2. a resolver that throws synchronously is "unresolvable", not a crash', thrown === null); }
}

/* ═════════ 3. fetchBounded against real local servers ═════════ */
// Fake public host names: policy-time (node:dns/promises) and connect-time (node:dns) answers are set separately, so a name can look public to
// the policy while its connection goes to a local test server — or look PRIVATE to the policy while the connection would reach the server.
const PUB = [{ address: '93.184.216.34', family: 4 }];
const fake = new Map(Object.entries({
  'pub-a.test': { policy: PUB }, 'pub-b.test': { policy: PUB }, 'pub-c.test': { policy: PUB }, 'v6pub.test': { policy: [{ address: '2606:4700:4700::1111', family: 6 }] },
  'rebind.test': { policy: [{ address: '10.1.2.3', family: 4 }] }, 'mixed.test': { policy: [{ address: '8.8.8.8', family: 4 }, { address: '192.168.0.9', family: 4 }] },
  'mapped.test': { policy: [{ address: '::ffff:127.0.0.1', family: 6 }] }, 'meta.test': { policy: [{ address: '169.254.169.254', family: 4 }] },
  'nx.test': { error: true }, 'hang.test': { hang: true },
  // names whose POLICY answer is a non-public address (their connection, like every name here, goes to loopback — never to the real address)
  'ten.test': { policy: [{ address: '10.0.0.1', family: 4 }] }, 'priv172.test': { policy: [{ address: '172.16.0.1', family: 4 }] }, 'priv192.test': { policy: [{ address: '192.168.0.1', family: 4 }] },
  'cgnat.test': { policy: [{ address: '100.64.0.1', family: 4 }] }, 'ula.test': { policy: [{ address: 'fd00::1', family: 6 }] }, 'ula-meta.test': { policy: [{ address: 'fd00:ec2::254', family: 6 }] },
  'linklocal.test': { policy: [{ address: 'fe80::1', family: 6 }] }, 'mcast.test': { policy: [{ address: '224.0.0.1', family: 4 }] }, 'mcast6.test': { policy: [{ address: 'ff02::1', family: 6 }] },
  // names the policy must refuse BEFORE resolving; if a weakened policy ever did resolve them the answer is "public", and the connection still goes to loopback
  'localhost': { policy: PUB }, 'localhost.': { policy: PUB }, 'foo.localhost': { policy: PUB },
}));
// SAFETY: every redirect target in sections 3 and 4 is either a LOOPBACK literal or one of these fake names. Literal NON-loopback addresses (10.0.0.1,
// 169.254.169.254, fd00::, …) are judged in section 2 only, where nothing is ever requested — so no weakening of the policy (see the mutation pass) can
// make this file touch a real address.
let realLookups = 0; const realNames = [];
const origCb = dns.lookup, origPromise = dnsp.lookup;
dns.lookup = function (host, opts, cb) {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  if (fake.has(String(host).toLowerCase())) return opts?.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4);   // connect-time: always the local test server
  if (!isIP(String(host))) { realLookups++; realNames.push(`connect:${host}`); }   // an IP literal passes straight through the resolver: not a DNS query
  return origCb.call(this, host, opts, cb);
};
dnsp.lookup = async (host, opts) => {
  const e = fake.get(String(host).toLowerCase());
  if (!e) { realLookups++; realNames.push(`policy:${host}`); return origPromise.call(dnsp, host, opts); }
  if (e.hang) return new Promise(() => {});
  if (e.error) throw Object.assign(new Error(`queryA ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
  return e.policy;
};

const servers = [], sockets = new Set();
const listen = (srv, host) => new Promise((resolve, reject) => { srv.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); }); srv.once('error', reject); srv.listen(0, host, () => { servers.push(srv); resolve(srv.address().port); }); });
const page = (t) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${t}</title><meta name="description" content="A description of ${t} that is comfortably longer than the minimum the analyzer expects."><link rel="canonical" href="/"></head><body><h1>${t}</h1><p>${'word '.repeat(60)}</p></body></html>`;

const hitsI = [], hitsI6 = [];
const mkInternal = (hits, tag) => http.createServer((req, res) => {
  hits.push({ url: req.url, host: req.headers.host });
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/r') { res.writeHead(302, { Location: u.searchParams.get('to') }); return res.end(); }
  if (u.pathname === '/robots.txt') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('User-agent: *\nDisallow: /private\nSitemap: http://off-host.example/sitemap.xml\n'); }
  if (u.pathname === '/sitemap.xml') { res.writeHead(200, { 'content-type': 'application/xml' }); return res.end('<urlset><url><loc>http://far.example/from-the-redirect-target</loc></url></urlset>'); }
  res.writeHead(200, { 'content-type': 'text/html' }); res.end(page(`${tag} ${u.pathname}`));
});
const Ip = await listen(mkInternal(hitsI, 'internal'), '127.0.0.1');
let I6p = null; try { I6p = await listen(mkInternal(hitsI6, 'internal6'), '::1'); } catch { /* no IPv6 loopback on this machine */ }

const hitsE = []; let endlessClosed = false; const slowSeen = new Set();
const E = http.createServer(async (req, res) => {
  hitsE.push(req.url);
  const u = new URL(req.url, 'http://x'), p = u.pathname;
  if (p === '/r') { res.writeHead(+(u.searchParams.get('code') || 302), { Location: u.searchParams.get('to') }); return res.end('redirecting'); }
  if (p === '/same') { res.writeHead(302, { Location: '/target' }); return res.end(); }
  if (p === '/abs') { res.writeHead(307, { Location: `http://127.0.0.1:${Ep}/target` }); return res.end(); }
  if (p === '/dir/deep/page') { res.writeHead(302, { Location: '../next' }); return res.end(); }
  if (p === '/utf8') { res.writeHead(302, { Location: Buffer.from('/caf\u00e9', 'utf8').toString('latin1') }); return res.end(); }
  if (p === '/utf8host') { res.writeHead(302, { Location: Buffer.from(`http://\u2460\u2461\u2466.0.0.1:${Ip}/via-utf8-host`, 'utf8').toString('latin1') }); return res.end(); }   // raw UTF-8 bytes: circled digits that the URL parser maps to 127.0.0.1
  if (p === '/target' || p === '/next' || p === '/\u00e9' || p.startsWith('/caf')) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(page(`edge ${p}`)); }
  if (p.startsWith('/chain/')) { const i = +p.split('/')[2], stop = +u.searchParams.get('stop'); if (i < stop) { res.writeHead(302, { Location: `/chain/${i + 1}?stop=${stop}` }); return res.end(); } res.writeHead(200, { 'content-type': 'text/html' }); return res.end(page(`chain ${i}`)); }
  if (p === '/loopA') { res.writeHead(302, { Location: '/loopB' }); return res.end(); }
  if (p === '/loopB') { res.writeHead(302, { Location: '/loopA' }); return res.end(); }
  if (p.startsWith('/slow/')) { slowSeen.add(p); const i = +p.split('/')[2], stop = +u.searchParams.get('stop'); await sleep(300); if (i < stop) { res.writeHead(302, { Location: `/slow/${i + 1}?stop=${stop}` }); return res.end(); } res.writeHead(200, { 'content-type': 'text/html' }); return res.end(page(`slow ${i}`)); }
  if (p === '/nolocation') { res.writeHead(301, { 'content-type': 'text/html' }); return res.end(page('moved, but nowhere')); }
  if (p === '/multiple') { res.writeHead(300, { Location: `http://127.0.0.1:${Ip}/via-300`, 'content-type': 'text/html' }); return res.end(page('multiple choices')); }
  if (p === '/badloc') { res.writeHead(302, { Location: u.searchParams.get('v') }); return res.end(); }
  if (p === '/endless302') { res.writeHead(302, { Location: '/target' }); res.on('close', () => { endlessClosed = true; }); const t = setInterval(() => { if (res.destroyed || res.writableEnded) return clearInterval(t); res.write('x'.repeat(512)); }, 15); return; }
  if (p === '/robots.txt' && E.robots) return E.robots(req, res);
  if (p === '/sitemap.xml' && E.sitemap) return E.sitemap(req, res);
  if (p === '/' && E.home) return E.home(req, res);
  if (p === '/robots.txt' || p === '/sitemap.xml') { res.writeHead(404); return res.end('no'); }
  res.writeHead(200, { 'content-type': 'text/html' }); res.end(page(`edge ${p}`));
});
const Ep = await listen(E, '127.0.0.1');
const edge = `http://127.0.0.1:${Ep}`, ib = `http://127.0.0.1:${Ip}`;
const get = async (url, opts = {}) => { const t0 = Date.now(); try { return { ok: true, value: await H.fetchBounded(url, { timeoutMs: 4000, maxBytes: 1 << 20, ...opts }), ms: Date.now() - t0 }; } catch (error) { return { ok: false, error, ms: Date.now() - t0 }; } };
const via = (to, code = 302) => `${edge}/r?code=${code}&to=${encodeURIComponent(to)}`;
const iHits = () => hitsI.length + hitsI6.length;

{
  ok('3. MAX_REDIRECTS is 10 — one explicit, exported limit, below the 20 the HTTP client would allow', H.MAX_REDIRECTS === 10);

  // same-host redirects keep working, with every redirect status and every spelling of the Location
  for (const code of [301, 302, 303, 307, 308]) { const r = await get(via(`${edge}/target`, code)); ok(`3. a same-host ${code} redirect is followed: final URL and body are returned`, r.ok && r.value.status === 200 && r.value.url === `${edge}/target` && /edge \/target/.test(r.value.text), String(r.error)); }
  { const r = await get(`${edge}/same`); ok('3. an absolute-path Location (/target) resolves against the redirecting URL', r.ok && r.value.url === `${edge}/target`, String(r.error)); }
  { const r = await get(`${edge}/abs`); ok('3. an absolute same-host Location is followed', r.ok && r.value.url === `${edge}/target`, String(r.error)); }
  { const r = await get(`${edge}/dir/deep/page`); ok('3. a relative Location (../next from /dir/deep/page) resolves to /dir/next… per the URL parser', r.ok && r.value.url === `${edge}/dir/next`, JSON.stringify([r.ok && r.value.url, String(r.error)])); }
  { const r = await get(`${edge}/utf8`); ok('3. a Location written in raw UTF-8 bytes is decoded as fetch itself decodes it (/café, not a double-encoded path)', r.ok && r.value.url === `${edge}/caf%C3%A9`, JSON.stringify([r.ok && r.value.url, String(r.error)])); }
  { const r = await get(`${edge}/target`); ok('3. a request with no redirect is unchanged: status, url, headers, text and ttfb', r.ok && r.value.status === 200 && r.value.ok === true && r.value.url === `${edge}/target` && typeof r.value.ttfbMs === 'number' && r.value.headers.get('content-type') === 'text/html'); }
  { const r = await get(`${edge}/nolocation`); ok('3. a 301 with NO Location is simply the response (as fetch handles it): status 301, body readable, nothing followed', r.ok && r.value.status === 301 && /moved, but nowhere/.test(r.value.text), String(r.error)); }
  { const b = iHits(); const r = await get(`${edge}/multiple`); ok('3. a 300 (not a redirect status) is returned as it is, its Location is not followed', r.ok && r.value.status === 300 && iHits() === b, String(r.error)); }

  // a redirect's own body is never read: an endless one must not stall the hop
  { endlessClosed = false; const r = await get(`${edge}/endless302`, { timeoutMs: 3000 }); await sleep(300);
    ok('3. a redirect response whose body never ends does not stall the crawl: the hop is followed at once and its connection is released', r.ok && r.value.url === `${edge}/target` && r.ms < 1500 && endlessClosed, JSON.stringify([r.ok, r.ms, endlessClosed, String(r.error)])); }

  // EVERY redirect status to loopback is refused, and the internal server never sees a request
  for (const code of [301, 302, 303, 307, 308]) { const b = iHits(); const r = await get(via(`${ib}/secret`, code)); ok(`3. a ${code} redirect to 127.0.0.1 is blocked before any request is made`, !r.ok && r.error.code === 'REDIRECT_BLOCKED' && r.error.reason === 'non-public-address' && iHits() === b, String(r.error)); }

  // the approved matrix of destinations, over the real client; where a server is listening, it must see NOTHING
  const spellings = [
    ['127.0.0.1', `http://127.0.0.1:${Ip}/`, 'non-public-address'], ['127.1', `http://127.1:${Ip}/`, 'non-public-address'], ['decimal 2130706433', `http://2130706433:${Ip}/`, 'non-public-address'],
    ['hex 0x7f000001', `http://0x7f000001:${Ip}/`, 'non-public-address'], ['dotted hex 0x7f.1', `http://0x7f.1:${Ip}/`, 'non-public-address'], ['octal 017700000001', `http://017700000001:${Ip}/`, 'non-public-address'],
    ['127.0.0.1. (trailing dot)', `http://127.0.0.1.:${Ip}/`, 'non-public-address'], ['percent-encoded unicode digits', `http://%E2%91%A0%E2%91%A1%E2%91%A6.0.0.1:${Ip}/`, 'non-public-address'],
    ['localhost', `http://localhost:${Ip}/`, 'non-public-name'], ['LOCALHOST', `http://LOCALHOST:${Ip}/`, 'non-public-name'], ['localhost.', `http://localhost.:${Ip}/`, 'non-public-name'], ['foo.localhost', `http://foo.localhost:${Ip}/`, 'non-public-name'],
    ['IPv4-mapped loopback [::ffff:127.0.0.1]', `http://[::ffff:127.0.0.1]:${Ip}/`, 'non-public-address'], ['IPv4-mapped loopback [::ffff:7f00:1]', `http://[::ffff:7f00:1]:${Ip}/`, 'non-public-address'],
    ['0.0.0.0', `http://0.0.0.0:${Ip}/`, 'non-public-address'], ['userinfo URL', `http://user:pass@127.0.0.1:${Ip}/`, 'credentials'], ['userinfo on a public-looking host', 'http://user:pass@pub-a.test/', 'credentials'],
    ['file:', 'file:///C:/Windows/win.ini', 'scheme'], ['ftp:', 'ftp://127.0.0.1/', 'scheme'], ['gopher:', 'gopher://127.0.0.1:70/', 'scheme'], ['data:', 'data:text/html,hi', 'scheme'], ['javascript:', 'javascript:alert(1)', 'scheme'],
    // the private RANGES and the metadata addresses, end to end, as names whose resolution lands there (the literal addresses themselves are judged in section 2 and never requested here)
    ['a name that resolves to 10.0.0.1', `http://ten.test:${Ip}/`, 'resolves-non-public'], ['a name that resolves to 172.16.0.1', `http://priv172.test:${Ip}/`, 'resolves-non-public'], ['a name that resolves to 192.168.0.1', `http://priv192.test:${Ip}/`, 'resolves-non-public'],
    ['a name that resolves to 100.64.0.1 (CGNAT)', `http://cgnat.test:${Ip}/`, 'resolves-non-public'], ['a name that resolves to an IPv6 unique-local address', `http://ula.test:${Ip}/`, 'resolves-non-public'], ['a name that resolves to the IPv6 metadata address fd00:ec2::254', `http://ula-meta.test:${Ip}/`, 'resolves-non-public'],
    ['a name that resolves to an IPv6 link-local address', `http://linklocal.test:${Ip}/`, 'resolves-non-public'], ['a name that resolves to IPv4 multicast', `http://mcast.test:${Ip}/`, 'resolves-non-public'], ['a name that resolves to IPv6 multicast', `http://mcast6.test:${Ip}/`, 'resolves-non-public'],
    ['a name that resolves to 10.1.2.3 (its connection would reach the local server)', `http://rebind.test:${Ip}/`, 'resolves-non-public'], ['a name with one public and one private address', `http://mixed.test:${Ip}/`, 'resolves-non-public'],
    ['a name that resolves to an IPv4-mapped loopback', `http://mapped.test:${Ip}/`, 'resolves-non-public'], ['a name that resolves to the metadata address', `http://meta.test:${Ip}/`, 'resolves-non-public'], ['a name that does not resolve', `http://nx.test:${Ip}/`, 'unresolvable'],
  ];
  if (I6p) spellings.push(['[::1] (a server really listens there)', `http://[::1]:${I6p}/`, 'non-public-address']);
  for (const [label, target, reason] of spellings) {
    const before = iHits(), beforeE = hitsE.length; const r = await get(via(target));
    ok(`3. redirect to ${label}: blocked (${reason}), no request reaches the target, and it fails at once`, !r.ok && r.error.code === 'REDIRECT_BLOCKED' && r.error.reason === reason && iHits() === before && hitsE.length === beforeE + 1 && r.ms < 1500, JSON.stringify([r.ok, r.error?.code, r.error?.reason, r.ms]));
  }
  { const b = iHits(); const r = await get(`${edge}/utf8host`); ok('3. a Location whose HOST is written in raw UTF-8 bytes (circled digits that normalize to 127.0.0.1) is decoded, normalized, recognised as loopback and blocked — nothing is requested', !r.ok && r.error.code === 'REDIRECT_BLOCKED' && r.error.reason === 'non-public-address' && iHits() === b, JSON.stringify([r.ok, r.error?.reason, r.error?.target])); }
  ok('3. the blocked-redirect error names what was refused and why, and is a RedirectBlockedError', await (async () => { const r = await get(via(`${ib}/x`)); return r.error instanceof H.RedirectBlockedError && /redirect to http:\/\/127\.0\.0\.1:\d+\/x was blocked: the destination is not a public address/.test(r.error.message) && r.error.target === `${ib}/x`; })());

  // chains
  { const b = iHits(), be = hitsE.length; const r = await get(via(via(`${ib}/deep`)));
    ok('3. a 2-hop redirect (same host, then to loopback) is blocked at the FINAL hop; both edge requests were made, the internal server saw none', !r.ok && r.error.code === 'REDIRECT_BLOCKED' && iHits() === b && hitsE.length === be + 2, JSON.stringify([r.error?.code, hitsE.length - be])); }
  { const b = hitsI.length; const r = await get(via(`http://pub-a.test:${Ip}/r?to=${encodeURIComponent(`http://127.0.0.1:${Ip}/leak`)}`));
    const seen = hitsI.slice(b).map((h) => `${h.host}${h.url.split('?')[0]}`);
    ok('3. public → public → loopback: the first (public) hop is followed, the second is blocked — the internal server saw the hop through the public name and never /leak', !r.ok && r.error.code === 'REDIRECT_BLOCKED' && seen.length === 1 && seen[0] === `pub-a.test:${Ip}/r`, JSON.stringify([r.error?.code, seen])); }
  { const b = hitsI.length; const r = await get(via(`http://pub-a.test:${Ip}/r?to=${encodeURIComponent(`http://pub-b.test:${Ip}/r?to=${encodeURIComponent(`http://pub-c.test:${Ip}/r?to=${encodeURIComponent(`http://localhost:${Ip}/leak`)}`)}`)}`));
    ok('3. three public hops are followed and a fourth, to localhost, is blocked', !r.ok && r.error.reason === 'non-public-name' && hitsI.length - b === 3 && !hitsI.slice(b).some((h) => /leak/.test(h.url.split('?')[0])), JSON.stringify([r.error?.reason, hitsI.length - b])); }

  // public cross-host redirects keep working
  { const b = hitsI.length; const r = await get(via(`http://pub-a.test:${Ip}/landing`));
    ok('3. a redirect to a PUBLIC other host (http) is followed; the final URL is the public host', r.ok && r.value.status === 200 && r.value.url === `http://pub-a.test:${Ip}/landing` && hitsI.length - b === 1 && hitsI[b].host === `pub-a.test:${Ip}`, JSON.stringify([r.ok, r.ok && r.value.url, String(r.error)])); }
  { const r = await get(via(`http://v6pub.test:${Ip}/landing`)); ok('3. …a public host that has a public IPv6 address is allowed too', r.ok && r.value.status === 200, String(r.error)); }
  { const r = await get(via(`http://pub-a.test:${Ip}/r?to=${encodeURIComponent(`http://pub-b.test:${Ip}/r?to=${encodeURIComponent(`http://pub-c.test:${Ip}/end`)}`)}`)); ok('3. …a chain of three public hops (a → b → c) is followed to the end', r.ok && r.value.url === `http://pub-c.test:${Ip}/end`, String(r.error)); }

  // hop limit and loops
  { const be = hitsE.length; const r = await get(`${edge}/chain/0?stop=1`); ok('3. a single redirect hop works', r.ok && r.value.url === `${edge}/chain/1?stop=1` && hitsE.length - be === 2, String(r.error)); }
  { const be = hitsE.length; const r = await get(`${edge}/chain/0?stop=10`); ok('3. BOUNDARY: a chain of exactly 10 redirects (11 requests) is followed to its end', r.ok && r.value.status === 200 && r.value.url === `${edge}/chain/10?stop=10` && hitsE.length - be === 11, JSON.stringify([r.ok, String(r.error), hitsE.length - be])); }
  { const be = hitsE.length; const r = await get(`${edge}/chain/0?stop=11`); ok('3. BOUNDARY: an 11th redirect is refused (TooManyRedirectsError); exactly 11 requests were made, the 12th never was', !r.ok && r.error instanceof H.TooManyRedirectsError && r.error.code === 'TOO_MANY_REDIRECTS' && r.error.maxRedirects === 10 && hitsE.length - be === 11, JSON.stringify([r.error?.code, hitsE.length - be])); }
  { const be = hitsE.length; const r = await get(`${edge}/chain/0?stop=500`); ok('3. a very long chain is cut at the same limit — not at the 20 the HTTP client would have allowed', !r.ok && r.error.code === 'TOO_MANY_REDIRECTS' && hitsE.length - be === 11, JSON.stringify([r.error?.code, hitsE.length - be])); }
  { const be = hitsE.length; const r = await get(`${edge}/loopA`); ok('3. a redirect loop A → B → A terminates at the hop limit', !r.ok && r.error.code === 'TOO_MANY_REDIRECTS' && hitsE.length - be === 11 && r.ms < 2000, JSON.stringify([r.error?.code, hitsE.length - be, r.ms])); }
  { const r = await get(`${edge}/badloc?v=${encodeURIComponent('http://')}`); ok('3. a Location that is not a URL is refused (invalid-location), not followed', !r.ok && r.error.code === 'REDIRECT_BLOCKED' && r.error.reason === 'invalid-location', JSON.stringify([r.error?.code, r.error?.reason])); }
  { const r = await get(`${edge}/badloc?v=${encodeURIComponent('http://[::1')}`); ok('3. …an unterminated IPv6 literal as well', !r.ok && r.error.reason === 'invalid-location', JSON.stringify([r.error?.code, r.error?.reason])); }

  // the deadline: ONE for the whole chain
  { slowSeen.clear(); const r = await get(`${edge}/slow/0?stop=5`, { timeoutMs: 1000 });
    ok('3. DEADLINE: a slow redirect chain (each hop 300 ms, six requests = 1.8 s) is cut at the ONE original timeout (1 s), not extended hop by hop — a RequestTimeoutError', !r.ok && r.error instanceof H.RequestTimeoutError && r.error.code === 'REQUEST_TIMEOUT' && r.ms >= 900 && r.ms < 1500 && slowSeen.size < 6, JSON.stringify([r.error?.code, r.ms, [...slowSeen]]));
    slowSeen.clear(); const c = await get(`${edge}/slow/0?stop=5`, { timeoutMs: 6000 });
    ok('3. …control: with a larger deadline the same chain completes (so each hop alone was well inside 1 s, and only the shared deadline stopped it)', c.ok && c.value.status === 200 && c.ms >= 1700 && slowSeen.size === 6, JSON.stringify([c.ok, c.ms, [...slowSeen], String(c.error)])); }
  { const t0 = Date.now(); const r = await get(via(`http://hang.test:${Ip}/`), { timeoutMs: 500 });
    ok('3. DEADLINE: a name resolution that never answers is bounded by the same deadline (RequestTimeoutError, no hang)', !r.ok && r.error.code === 'REQUEST_TIMEOUT' && r.ms >= 450 && r.ms < 1500, JSON.stringify([r.error?.code, r.ms])); }
  { const r = await get(`${edge}/chain/0?stop=3`, { timeoutMs: 4000, maxBytes: 20 }); ok('3. the size cap still applies to the FINAL response after redirects (ResponseTooLargeError)', !r.ok && r.error.code === 'RESPONSE_TOO_LARGE', JSON.stringify([r.error?.code])); }
  { const r = await get(`http://user:pass@127.0.0.1:${Ip}/`); ok('3. the FIRST url is the caller\'s own and behaves as before: embedded credentials still make the underlying fetch throw (nothing was requested)', !r.ok && r.error instanceof TypeError, String(r.error)); }
  { const b = iHits(); const r = await get(`${ib}/direct`); ok('3. the first request itself is not subject to the redirect policy (the audited site may be local): a direct request to a loopback server works', r.ok && r.value.status === 200 && iHits() === b + 1); }
}

/* ═════════ 4. robots.txt, sitemaps and pages inherit the protection ═════════ */
{
  const hostE = new URL(edge).host;
  // robots.txt
  E.robots = (req, res) => { res.writeHead(302, { Location: `${ib}/robots.txt` }); res.end(); };
  { const b = iHits(); const robots = await fetchRobots(edge, { timeoutMs: 3000 }); ok('4. robots.txt on the audited host that redirects to a loopback server: blocked — treated as missing, and the internal server saw no request', robots.exists === false && iHits() === b, JSON.stringify(robots)); }
  E.robots = (req, res) => { res.writeHead(302, { Location: `http://pub-a.test:${Ip}/robots.txt` }); res.end(); };
  { const b = hitsI.length; const robots = await fetchRobots(edge, { timeoutMs: 3000 }); ok('4. …but a robots.txt that redirects to a PUBLIC host is followed and parsed as before (rules and Sitemap lines)', robots.exists === true && robots.groups.length === 1 && robots.sitemaps.join() === 'http://off-host.example/sitemap.xml' && hitsI.length - b === 1, JSON.stringify(robots)); }
  E.robots = null;

  // sitemaps
  E.sitemap = (req, res) => { res.writeHead(301, { Location: `${ib}/sitemap.xml` }); res.end(); };
  { const b = iHits(); const out = await discoverSitemaps(edge, [], { timeoutMs: 3000, allowedHost: hostE }); ok('4. a same-host sitemap.xml that redirects to a loopback server: blocked — reported as an unreadable sitemap with the reason, no entries, and the internal server saw no request', out.length === 1 && /redirect to http:\/\/127\.0\.0\.1:\d+\/sitemap\.xml was blocked/.test(out[0].error || '') && out[0].entries.length === 0 && iHits() === b, JSON.stringify(out)); }
  E.sitemap = (req, res) => { res.writeHead(307, { Location: `http://pub-a.test:${Ip}/sitemap.xml` }); res.end(); };
  { const out = await discoverSitemaps(edge, [], { timeoutMs: 3000, allowedHost: hostE }); ok('4. …a sitemap that redirects to a PUBLIC host is followed and parsed as before', out.length === 1 && out[0].error === null && out[0].entries.length === 1 && out[0].entries[0].loc === 'http://far.example/from-the-redirect-target', JSON.stringify(out)); }
  E.sitemap = null;
  { const b = iHits(); const out = await discoverSitemaps(edge, [`${ib}/sitemap.xml`, 'http://off-host.example/sitemap.xml'], { timeoutMs: 3000, allowedHost: hostE });
    const off = out.filter((s) => !s.url.startsWith(edge));
    ok('4. existing behaviour kept: sitemap URLs on OTHER hosts are still refused up front with the same message, and never requested', off.length === 2 && off.every((s) => s.error === 'outside the configured domain — not fetched') && iHits() === b, JSON.stringify(off)); }

  // pages, through the real crawler and the real analyzer
  E.home = (req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(page('edge home').replace('</body>', `<a href="/r?to=${encodeURIComponent(`${ib}/stolen`)}">to loopback</a><a href="/r?to=${encodeURIComponent(`http://pub-a.test:${Ip}/landing`)}">to a public host</a><a href="/same">same-host redirect</a><a href="/nolocation">a 301 that goes nowhere</a><a href="/r?to=${encodeURIComponent(`http://meta.test:${Ip}/latest/meta-data/`)}">to a name that resolves to the metadata address</a></body>`));
  };
  { const b = iHits();
    const crawl = await crawlWebsite(`${edge}/`, { maxPages: 10, maxDepth: 1, requestTimeoutMs: 3000, crawlDelayMs: 0 });
    const byPath = (frag) => crawl.pages.find((p) => p.url.includes(frag));
    const toLoop = byPath(encodeURIComponent(`${ib}/stolen`)), toMeta = crawl.pages.find((p) => decodeURIComponent(p.url).includes('meta.test'));
    ok('4. a same-host PAGE that redirects to a loopback server is blocked before the internal server receives anything', !!toLoop && iHits() === b + 1 && !hitsI.some((h) => /stolen/.test(h.url)), JSON.stringify([toLoop && toLoop.error, iHits() - b]));
    ok('4. …it is recorded as an ordinary page error (no status, the reason says why) and in the crawl\'s error list', !!toLoop && toLoop.statusCode === null && /was blocked: the destination is not a public address/.test(toLoop.error) && crawl.errors.some((e) => e.url === toLoop.url && /blocked/.test(e.error)), JSON.stringify(toLoop && toLoop.error));
    ok('4. …and a page redirecting to a name that resolves to the metadata address is blocked the same way, with no request made', !!toMeta && toMeta.statusCode === null && /meta\.test/.test(toMeta.error) && /resolves to a non-public address/.test(toMeta.error) && !hitsI.some((h) => /latest\/meta-data/.test(h.url)), JSON.stringify(toMeta && toMeta.error));
    const toPublic = crawl.pages.find((p) => decodeURIComponent(p.url).includes('pub-a.test')), same = byPath('/same');
    ok('4. a page that redirects to a PUBLIC other host still works: crawled, with the final URL on the public host', !!toPublic && toPublic.statusCode === 200 && toPublic.finalUrl === `http://pub-a.test:${Ip}/landing` && toPublic.redirected === true, JSON.stringify(toPublic && [toPublic.statusCode, toPublic.finalUrl]));
    ok('4. …and a same-host redirect is crawled as before (final URL on the same host)', !!same && same.statusCode === 200 && same.finalUrl === `${edge}/target` && same.redirected === true);
    const issues = analyzePages(crawl);
    ok('4. the existing SEO finding is intact: the redirect to another host is still reported as "redirects-external" (and the same-host redirect is not)', issues.some((i) => i.type === 'redirects-external' && i.detail.includes(`pub-a.test:${Ip}`)) && !issues.some((i) => i.type === 'redirects-external' && i.detail.includes('/same')), JSON.stringify(issues.filter((i) => /redirect/.test(i.type)).map((i) => i.detail)));
    ok('4. …and the other redirect findings still appear for a 3xx that is not followed (a 301 with no Location): redirect and link-to-redirect', issues.some((i) => i.type === 'redirect' && i.detail.includes('/nolocation')) && issues.some((i) => i.type === 'link-to-redirect' && i.detail.includes('/nolocation')), JSON.stringify(issues.filter((i) => /redirect/.test(i.type)).map((i) => i.type)));
    ok('4. the crawl as a whole completed (the blocked pages did not abort it)', crawl.pages.length >= 5 && crawl.pages[0].statusCode === 200);
  }
  { // the START page redirecting somewhere private
    E.home = (req, res) => { res.writeHead(302, { Location: `${ib}/` }); res.end(); };
    const b = iHits(); const crawl = await crawlWebsite(`${edge}/`, { maxPages: 3, maxDepth: 1, requestTimeoutMs: 3000, crawlDelayMs: 0 });
    ok('4. a START page that redirects to a loopback server is blocked: no page content is read, the error says so, and the internal server saw nothing', crawl.pages[0].statusCode === null && /was blocked/.test(crawl.pages[0].error) && iHits() === b, JSON.stringify(crawl.pages[0].error)); }
  E.home = null;
}

/* ═════════ 5. scope proofs ═════════ */
{
  const strip = (code) => code.replace(/(^|\n)[ \t]*\/\*[\s\S]*?\*\//g, '$1').replace(/(^|[ \t;{}])\/\/.*$/gm, '$1');
  const httpCode = strip(src('./seo/http.js')), ssrfCode = strip(src('./seo/ssrf.js'));
  const callers = { 'crawler.js': strip(src('./seo/crawler.js')), 'robots.js': strip(src('./seo/robots.js')), 'sitemap.js': strip(src('./seo/sitemap.js')) };
  ok('5. http.js asks fetch for redirect: \'manual\' — fetch never follows a redirect itself — and \'follow\' appears nowhere in it', /redirect: 'manual'/.test(httpCode) && !/'follow'/.test(httpCode) && !/redirect = /.test(httpCode));
  ok('5. http.js has exactly ONE fetch() call, inside the bounded loop, and exactly one timer: the deadline is set once, never per hop', (httpCode.match(/(^|[^.\w])fetch\s*\(/g) || []).length === 1 && (httpCode.match(/setTimeout\(/g) || []).length === 1 && (httpCode.match(/AbortSignal\.timeout|new AbortController/g) || []).length === 1);
  ok('5. the limit is the one exported constant (10); the loop refuses the hop AFTER it, and counts nothing else', /export const MAX_REDIRECTS = 10;/.test(httpCode) && /if \(followed >= MAX_REDIRECTS\) throw new TooManyRedirectsError\(MAX_REDIRECTS\);/.test(httpCode) && (httpCode.match(/MAX_REDIRECTS/g) || []).length === 3);
  ok('5. every hop is resolved against the URL that returned it, validated, and only the VALIDATED URL is requested next', /new URL\(decodeLocation\(location\), from\)/.test(httpCode) && /checkRedirectTarget\(next, from, \{ signal: controller\.signal \}\)/.test(httpCode) && /if \(!verdict\.ok\) throw new RedirectBlockedError\(verdict\.reason, next\);\s*current = next\.href;/.test(httpCode) && (httpCode.match(/checkRedirectTarget\(/g) || []).length === 1);
  ok('5. exactly the five redirect statuses are followed', /new Set\(\[301, 302, 303, 307, 308\]\)/.test(httpCode));
  ok('5. the policy lives in ssrf.js, which imports only node:dns/promises and node:net, makes no request and has no HTTP client', [...src('./seo/ssrf.js').matchAll(/^import .* from '([^']+)';/gm)].map((m) => m[1]).sort().join() === 'node:dns/promises,node:net' && !/\bfetch\s*\(|node:https?\b|undici|axios|net\.connect|\.request\(/.test(ssrfCode));
  ok('5. the callers are untouched in kind: crawler, robots and sitemap code know nothing about redirects or the policy — they just call the helper', Object.values(callers).every((c) => !/ssrf|checkRedirectTarget|MAX_REDIRECTS|redirect:|'manual'|\bfollow\b/.test(c)));
  const pkg = JSON.parse(src('../package.json'));
  const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  ok('5. no dependency was added for this: no HTTP client, URL-filter or IP-parsing package', !deps.some((d) => /^(undici|axios|got|node-fetch|superagent|request|ssrf|ssrf-req-filter|ipaddr\.js|ip-address|is-ip|ip|private-ip|ip-regex|cidr)/.test(d)), deps.join());
  const readme = readFileSync(fileURLToPath(new URL('../README.md', import.meta.url)), 'utf8');
  ok('5. the documentation no longer claims the crawler "never leaves the start URL\'s host", and states the redirect policy and the DNS limitation', !/never leaves the start URL's host/.test(readme) && /non-public/i.test(readme) && /DNS rebinding/i.test(readme) && !/never leaves that URL's host/.test(src('./seo/crawler.js')));
  ok('5. the sitemap fetch cap and the crawl limits are untouched (const MAX_SITEMAPS = 15;, four crawl limits)', /const MAX_SITEMAPS = 15;/.test(src('./seo/sitemap.js')) && Object.keys((await import(new URL('./seo/limits.js', import.meta.url).href)).crawlLimits()).sort().join() === 'crawlDelayMs,maxDepth,maxPages,requestTimeoutMs');
  ok('5. no production file other than http.js uses the policy or the redirect classes', (() => { const files = []; for (const dir of ['.', './seo', './admin']) for (const f of readdirSync(fileURLToPath(new URL(dir + '/', import.meta.url)))) if (/\.(js|mjs)$/.test(f) && !f.startsWith('test-')) files.push(`${dir}/${f}`); return files.filter((f) => /checkRedirectTarget|RedirectBlockedError|TooManyRedirectsError/.test(strip(src(f)))).sort().join(','); })() === './seo/http.js,./seo/ssrf.js');
  ok('5. every test in this file resolved names only through the fake resolver: not one real DNS lookup was made', realLookups === 0, realNames.join(' '));
  { // SAFETY of the suite itself: the end-to-end sections only ever name loopback literals or fake names, so even a weakened policy cannot make them touch a real address
    const self = src('./test-seo-redirect-ssrf.mjs'), live = self.slice(self.indexOf('═════════ 3. fetchBounded'), self.indexOf('═════════ 5. scope proofs'));
    const literals = [...live.matchAll(/https?:\/\/(?:[^\s'"`\/@]*@)?(\d+\.\d+\.\d+\.\d+|\[[0-9a-f:.]+\])/gi)].map((m) => m[1]);
    const isLoopbackOnly = (h) => /^(127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\]|\[::ffff:127\.0\.0\.1\]|\[::ffff:7f00:1\])$/i.test(h);
    ok('5. SAFETY: sections 3 and 4 request only loopback literals and fake host names — no real private, link-local, metadata or public address appears in them', live.length > 1000 && literals.length > 5 && literals.every(isLoopbackOnly), JSON.stringify(literals.filter((h) => !isLoopbackOnly(h))));
  }
}

dns.lookup = origCb; dnsp.lookup = origPromise;
for (const s of sockets) s.destroy();
for (const s of servers) s.close();
console.log(`\n${pass} passed, ${fail} failed`);
setTimeout(() => process.exit(fail ? 1 : 0), 300);
