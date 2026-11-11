import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import yaml from 'js-yaml';
import { quantumultXReferences } from '../src/core/quantumultx-config';

let directory: string, child: ChildProcess, origin: string, upstreamOrigin: string;
const bodies = new Map<string, string>();
const upstream = createServer((request, response) => {
  response.setHeader('subscription-userinfo', 'upload=10; download=20; total=1000; expire=2000000000');
  response.end(bodies.get(request.url || '/') || 'proxies: []');
});
async function startApp() {
  child = spawn(process.execPath, ['--import', 'tsx', join(__dirname, 'helpers/http-server.ts')], { env: { ...process.env, SUBONE_ROOT: directory }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let errors = ''; child.stderr?.on('data', chunk => { errors += chunk; });
  const message = await Promise.race([once(child, 'message'), once(child, 'exit').then(([code]) => { throw new Error(`Server exited ${code}: ${errors}`); })]);
  origin = `http://127.0.0.1:${message[0].port}`;
}
async function stopApp() { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; }
async function api(path: string, method = 'GET', value?: unknown): Promise<any> {
  const response = await fetch(`${origin}/api${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: value === undefined ? undefined : JSON.stringify(value) });
  return { status: response.status, ...await response.json() as any };
}
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'subone-quantumultx-http-'));
  await writeFile(join(directory, 'config.json'), JSON.stringify({ port: 3456, adminPassword: '' }));
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening'); const address = upstream.address(); assert.ok(address && typeof address !== 'string');
  upstreamOrigin = `http://127.0.0.1:${address.port}`; await startApp();
});
after(async () => { await stopApp(); await new Promise<void>(resolve => upstream.close(() => resolve())); await rm(directory, { recursive: true, force: true }); });
const dns = '[dns]\n# Exact user DNS remains ordinary DNS\nno-system\nprefer-doh3\nserver = 192.0.2.53\ndoh-server = https://template.example/dns-query, https://second.example/dns-query\ndoq-server = quic://template.example\ndot-server = tls://retained.example\ndoh-headers = X-Template: preserve\nserver = /kept.example/192.0.2.54\n\n';
const template = '[general]\nserver_check_url = https://example.com/check\n\n' + dns + '[server_local]\n\n[policy]\n\n[filter_local]\nfinal, direct\n';
const dnsSection = (content: string) => content.slice(content.indexOf('[dns]'), content.indexOf('[server_local]'));
async function add(path: string, services: string[], extra: any = {}) {
  bodies.set(path, yaml.dump({ proxies: [{ name: 'Shared', type: 'socks5', server: path.slice(1) + '.node.example', port: 1080 }], dns: { nameserver: services }, ...extra }));
  const result = await api('/sources', 'POST', { name: path.slice(1), url: upstreamOrigin + path }); assert.equal(result.success, true, result.message); return result.data;
}
async function profileFor(sources: any[], content = template, filter?: any, groups?: any[]) {
  const group = (await api('/groups', 'POST', { name: `Candidates-${Math.random()}`, type: 'select', includeAll: true, sources: sources.map(source => source.id) })).data;
  const created = await api('/templates', 'POST', { name: 'QX custom', type: 'quantumultx', content }); const tpl = created.data;
  assert.ok(tpl, JSON.stringify(created));
  const profile = (await api('/profiles', 'POST', { name: 'QX profile', nodeFilter: filter || { mode: 'all', sourceIds: sources.map(source => source.id) }, selectedGroupIds: (groups || [group]).map(group => group.id), selectedRuleIds: ['no-unified-rule'], templates: { quantumultx: tpl.id } })).data;
  return { profile, group, tpl };
}
const preview = (profile: any, expandNodes = true) => api('/generate/preview', 'POST', { profileId: profile.id, customType: 'quantumultx', expandNodes });

test('AnyTLS certificate verification survives QuanX import, full download and both node resources', async () => {
  const path = '/qx-anytls-verification';
  bodies.set(path, '[server_local]\n' + [false, true].map(verification => `anytls=anytls-${verification}.example:443, password=fixture-password, over-tls=true, tls-host=tls.example, tls-verification=${verification}, tag=AnyTLS ${verification}`).join('\n'));
  const created = await api('/sources', 'POST', { name: 'AnyTLS verification', url: upstreamOrigin + path });
  assert.equal(created.success, true, JSON.stringify(created));
  const source = created.data;
  assert.deepEqual(source.nodes.map((node: any) => node.skipCertVerify), [true, false]);
  const { profile } = await profileFor([source]);
  const assertVerification = (content: string) => {
    for (const verification of [false, true]) assert.match(content, new RegExp(`^anytls=anytls-${verification}\\.example:443,.*tls-host=tls\\.example, tls-verification=${verification},.*tag=AnyTLS ${verification}$`, 'm'));
  };
  const result = await preview(profile);
  assert.equal(result.success, true, JSON.stringify(result));
  assertVerification(result.data);
  for (const resource of ['qx', 'nodes/qx', `source/${source.id}?target=quantumultx`]) {
    const response = await fetch(`${origin}/s/${profile.token}/${resource}`);
    assert.equal(response.status, 200);
    assertVerification(await response.text());
  }
});

const aliasHosts = { 'entry.source.example': 'real.backend.test', 'unused.source.example': 'unused.backend.test', '*.wildcard.example': 'wildcard.backend.test', 'ip.source.example': '192.0.2.42' };
async function addAliasedSource(path: string) {
  return add(path, ['https://192.0.2.10/dns-query'], {
    hosts: aliasHosts,
    proxies: [{ name: 'Aliased Trojan', type: 'trojan', server: 'entry.source.example', port: 443, password: 'fixture-password', sni: 'tls.example', 'skip-cert-verify': true }],
  });
}
function assertAliasDns(content: string) {
  assert.match(content, /^alias = \/entry\.source\.example\/real\.backend\.test$/m);
  for (const domain of ['entry.source.example', 'real.backend.test']) assert.ok(content.includes(`doh-server = /${domain}/https://192.0.2.10/dns-query`), content);
  assert.doesNotMatch(dnsSection(content), /unused\.|wildcard\.|ip\.source|192\.0\.2\.42/);
}

test('Mihomo node domain aliases are saved and emitted with their source DNS in QuanX downloads', async () => {
  const source = await addAliasedSource('/qx-mihomo-alias');
  assert.equal(source.doh.domainAliases?.['entry.source.example'], 'real.backend.test');
  const { profile } = await profileFor([source]);
  const result = await preview(profile);
  assert.equal(result.success, true, JSON.stringify(result));
  assertAliasDns(result.data);
  assert.match(result.data, /^trojan=entry\.source\.example:443,.*tls-host=tls\.example, tls-verification=false,/m);
  const response = await fetch(`${origin}/s/${profile.token}/qx`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), result.data);
});

for (const snapshot of ['successful-document', 'failed-latest-response', 'base64-raw-only'] as const) {
  test(`Mihomo aliases recover from an existing ${snapshot} cache without refetching the upstream`, async () => {
    const path = `/qx-mihomo-alias-cache-${snapshot}`;
    let requests = 0;
    const count = (request: { url?: string }) => { if (request.url === path) requests++; };
    upstream.on('request', count);
    try {
      const source = await addAliasedSource(path);
      const { profile } = await profileFor([source]);
      assert.equal(requests, 1);
      await stopApp();
      try {
        const file = join(directory, 'data/subone_data.json');
        const data = JSON.parse(await readFile(file, 'utf8'));
        const saved = data.sources.find((entry: any) => entry.id === source.id);
        delete saved.doh.domainAliases;
        if (snapshot === 'failed-latest-response') {
          saved.rawSubscription.parseStatus = 'failed';
          saved.rawSubscription.content = yaml.dump({ hosts: { 'entry.source.example': 'failed-response.example' } });
        }
        if (snapshot === 'base64-raw-only') {
          delete saved.parsedConfig;
          saved.rawSubscription.content = Buffer.from(saved.rawSubscription.content).toString('base64');
          saved.rawSubscription.encoding = 'base64';
        }
        await writeFile(file, JSON.stringify(data));
      } finally { await startApp(); }
      const result = await preview(profile);
      assert.equal(result.success, true, JSON.stringify(result));
      assertAliasDns(result.data);
      assert.doesNotMatch(result.data, /failed-response\.example/);
      const response = await fetch(`${origin}/s/${profile.token}/qx`);
      assert.equal(response.status, 200);
      assert.equal(await response.text(), result.data);
      assert.equal(requests, 1);
    } finally { upstream.off('request', count); }
  });
}

test('default Quantumult X downloads contain the selected nodes without fetching resources or adding source groups', async () => {
  const a = await add('/qx-initial-a', [], { proxies: [{ name: 'Initial Trojan', type: 'trojan', server: 'trojan.initial.example', port: 443, password: 'fixture-password' }] });
  const b = await add('/qx-initial-b', [], { proxies: [{ name: 'Initial AnyTLS', type: 'anytls', server: 'anytls.initial.example', port: 443, password: 'fixture-password' }] });
  const group = (await api('/groups', 'POST', { name: 'Initial choice', type: 'select', proxies: ['DIRECT', `node:${a.nodes[0].id}`, `node:${b.nodes[0].id}`] })).data;
  const { profile } = await profileFor([a, b], template, undefined, [group]);
  const expected = await preview(profile);
  assert.equal(expected.success, true, JSON.stringify(expected));
  assert.match(expected.data, /^trojan=trojan\.initial\.example:443,.*tag=Initial Trojan$/m);
  assert.match(expected.data, /^anytls=anytls\.initial\.example:443,.*tag=Initial AnyTLS$/m);
  assert.doesNotMatch(expected.data, /qx-initial-[ab]|\/source\//);

  const defaultPreview = await api('/generate/preview', 'POST', { profileId: profile.id, customType: 'quantumultx' });
  assert.equal(defaultPreview.success, true, JSON.stringify(defaultPreview));
  assert.equal(defaultPreview.data, expected.data);
  for (const path of ['qx', 'quantumultx', '?target=qx']) {
    const response = await fetch(`${origin}/s/${profile.token}/${path}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('X-SubOne-Mode'), 'complete');
    assert.equal(await response.text(), expected.data);
  }
});

test('QuanX downloads keep a single hash candidate explicit and restore hashing after an upstream update', async () => {
  const source = await add('/qx-hash-single', [], { proxies: [
    { name: '🇨🇳 台湾W01 | IEPL | x2', type: 'ss', server: 'tw.hash.example', port: 443, cipher: 'aes-128-gcm', password: 'fixture-password' },
    { name: 'HK Other', type: 'socks5', server: 'hk.hash.example', port: 1080 },
  ] });
  const other = await add('/qx-hash-other', [], { proxies: [
    { name: '🇨🇳 台湾W02 | IEPL | x2', type: 'socks5', server: 'other.hash.example', port: 1080 },
  ] });
  const added = await api('/groups', 'POST', {
    name: 'AUTO_TW', type: 'load-balance', strategy: 'consistent-hashing',
    sources: [source.id], filter: '台湾',
  });
  assert.equal(added.success, true, JSON.stringify(added));
  const { profile } = await profileFor([source, other], template, undefined, [added.data]);

  for (const expandNodes of [true, false]) {
    const result = await preview(profile, expandNodes);
    assert.equal(result.success, true, JSON.stringify(result));
    const policy = result.data.split('\n').find((line: string) => line.startsWith('static=AUTO_TW,'));
    assert.ok(policy);
    assert.deepEqual(quantumultXReferences({ quantumultxLines: ['[policy]', policy] }).map(reference => reference.literal), [source.nodes[0].name]);
    assert.doesNotMatch(policy, /(?:resource|server)-tag-regex=|, direct(?:,|$)/);
    const response = await fetch(`${origin}/s/${profile.token}/qx?expand=${expandNodes}`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), result.data);
  }
  const saved = (await api('/groups')).data.find((group: any) => group.id === added.data.id);
  assert.equal(saved.type, 'load-balance');
  assert.equal(saved.strategy, 'consistent-hashing');
  bodies.set('/qx-hash-single', yaml.dump({ proxies: [
    { name: '🇨🇳 台湾W01 | IEPL | x2', type: 'ss', server: 'tw.hash.example', port: 443, cipher: 'aes-128-gcm', password: 'fixture-password' },
    { name: '🇨🇳 台湾W03 | IEPL | x2', type: 'socks5', server: 'tw-three.hash.example', port: 1080 },
  ] }));
  const refreshed = await api(`/sources/${source.id}/refresh`, 'POST');
  assert.equal(refreshed.success, true, JSON.stringify(refreshed));
  const updated = await preview(profile);
  assert.equal(updated.success, true, JSON.stringify(updated));
  const policy = updated.data.split('\n').find((line: string) => line.startsWith('dest-hash=AUTO_TW,'));
  assert.ok(policy);
  assert.deepEqual(quantumultXReferences({ quantumultxLines: ['[policy]', policy] }).map(reference => reference.literal), ['🇨🇳 台湾W01 | IEPL | x2', '🇨🇳 台湾W03 | IEPL | x2']);
});

test('QuanX AUTO groups retain explicit local candidates for complete and resource-based downloads', async () => {
  const source = await add('/qx-auto-members', [], { proxies: [
    { name: 'SGP 01', type: 'socks5', server: 'sg-one.example', port: 1080 },
    { name: 'SGP 02', type: 'socks5', server: 'sg-two.example', port: 1080 },
    { name: 'HK Other', type: 'socks5', server: 'hk-other.example', port: 1080 },
  ] });
  const other = await add('/qx-auto-other', [], { proxies: [
    { name: 'SGP Excluded', type: 'socks5', server: 'sg-other.example', port: 1080 },
  ] });
  for (const item of [source, other]) await api(`/sources/${item.id}`, 'PUT', { nameTemplate: '' });
  const group = (await api('/groups', 'POST', {
    name: 'AUTO_SGP', type: 'load-balance', strategy: 'consistent-hashing', sources: [source.id], filter: '^SGP',
  })).data;
  const { profile } = await profileFor([source, other], template, undefined, [group]);
  for (const expandNodes of [true, false]) {
    const result = await preview(profile, expandNodes);
    assert.equal(result.success, true, JSON.stringify(result));
    const policy = result.data.split('\n').find((line: string) => line.startsWith('dest-hash=AUTO_SGP,'));
    assert.ok(policy);
    assert.deepEqual(quantumultXReferences({ quantumultxLines: ['[policy]', policy] }).map(reference => reference.literal), ['SGP 01', 'SGP 02']);
    assert.doesNotMatch(policy, /(?:resource|server)-tag-regex=|, direct(?:,|$)/);
    const response = await fetch(`${origin}/s/${profile.token}/qx?expand=${expandNodes}`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), result.data);
  }
});

test('VMess TCP TLS uses native obfs fields in full downloads and both node resource endpoints', async () => {
  const uuid = '11111111-1111-4111-8111-111111111111';
  const source = await add('/qx-vmess-tls', [], { proxies: [
    { name: 'VMess TLS', type: 'vmess', server: 'vmess-tls.example', port: 21581, uuid, cipher: 'auto', tls: true },
    { name: 'VMess SNI', type: 'vmess', server: 'vmess-sni.example', port: 443, uuid, cipher: 'auto', tls: true, servername: 'sni.example', 'skip-cert-verify': true },
  ] });
  const { profile } = await profileFor([source]);
  const assertTls = (content: string) => {
    const nodes = content.split('\n').filter(line => line.startsWith('vmess='));
    assert.equal(nodes.length, 2);
    assert.match(nodes[0], /^vmess=vmess-tls\.example:21581, method=none,.*obfs=over-tls, tls-verification=true,.*tag=VMess TLS$/);
    assert.match(nodes[1], /^vmess=vmess-sni\.example:443, method=none,.*obfs=over-tls, obfs-host=sni\.example, tls-verification=false,.*tag=VMess SNI$/);
    for (const line of nodes) assert.doesNotMatch(line, /(?:^|, )(?:tls|tls-host)=/);
  };

  for (const expandNodes of [true, false]) {
    const result = await preview(profile, expandNodes);
    assert.equal(result.success, true, JSON.stringify(result));
    const download = await fetch(`${origin}/s/${profile.token}/qx?expand=${expandNodes}`);
    assert.equal(download.status, 200);
    assert.equal(await download.text(), result.data);
    if (expandNodes) {
      assertTls(result.data);
      const defaultDownload = await fetch(`${origin}/s/${profile.token}/qx`);
      assert.equal(defaultDownload.status, 200);
      assert.equal(await defaultDownload.text(), result.data);
    }
  }
  for (const path of ['nodes/qx', `source/${source.id}?target=quantumultx`]) {
    const resource = await fetch(`${origin}/s/${profile.token}/${path}`);
    assert.equal(resource.status, 200);
    assertTls(await resource.text());
  }
});

test('scoped DNS takeover preserves other entries and SSID options regardless of their position on the line', async () => {
  const source = await add('/qx-scoped-takeover', ['https://192.0.2.10/dns-query']);
  const owned = `/${source.nodes[0].server}/https://192.0.2.20/dns-query`;
  const retained = '/unrelated.example/https://192.0.2.21/dns-query';
  for (const entries of [[owned, retained], [retained, owned]]) {
    const content = template.replace('[dns]\n', `[dns]\ndoh-server = ${entries.join(', ')}, excluded_ssids=SSID1, SSID2\n`);
    const { profile, tpl } = await profileFor([source], content);
    const result = await preview(profile);
    assert.equal(result.success, true, JSON.stringify(result));
    assert.ok(result.data.includes(`doh-server = ${retained}, excluded_ssids=SSID1, SSID2`));
    assert.ok(result.data.includes(`/${source.nodes[0].server}/https://192.0.2.10/dns-query`));
    assert.doesNotMatch(result.data, /192\.0\.2\.20/);
    assert.equal(await fetch(`${origin}/s/${profile.token}/quantumultx?expand=true`).then(response => response.text()), result.data);
    assert.equal((await api('/templates')).data.find((entry: any) => entry.id === tpl.id).content, content);
  }
});

test('Quantumult X adopts supported source DNS while retaining unsupported connection intent and template DNS', async () => {
  const services = ['https://first.source.example/dns-query#DIRECT', 'https://second.source.example/dns-query#Missing'];
  const a = await add('/qx-capacity-a', services), b = await add('/qx-capacity-b', services), c = await add('/qx-capacity-c', ['https://different.source.example/dns-query']);
  const { profile } = await profileFor([a, b, c]);
  const result = await preview(profile); assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.generation.target.version, '1.8.1');
  assert.equal(dnsSection(result.data).replace(/^doh-server\s*=\s*\/.*\n/gm, ''), dns);
  assert.equal(result.generation.bindings.length, 3);
  for (const source of [a, b, c]) {
    const binding = result.generation.bindings.find((value: any) => value.sourceId === source.id);
    assert.equal(binding.status, source.id === c.id ? 'applied' : 'unapplied'); assert.equal(binding.method, source.id === c.id ? 'quantumultx-domain-doh' : 'template-dns'); assert.equal(binding.batchId, source.doh.batchId);
    assert.deepEqual(binding.appliedServiceIds, source.id === c.id ? c.doh.services.map((entry: any) => entry.id) : []); assert.deepEqual(binding.services.map((entry: any) => entry.url), source.doh.services.map((entry: any) => entry.url));
    if (source.id !== c.id) assert.ok(binding.diagnostics.some((entry: any) => entry.code === 'source-doh-options-unapplied'));
    else assert.equal(binding.diagnostics.length, 0);
  }
  assert.equal(result.generation.dependencyNodeCount, 0);
  assert.equal(await fetch(`${origin}/s/${profile.token}/quantumultx?expand=true`).then(response => response.text()), result.data);
  const saved = (await api('/sources')).data;
  for (const source of [a,b,c]) assert.deepEqual(saved.find((value: any) => value.id === source.id).doh, source.doh);
  await stopApp(); await startApp(); assert.deepEqual(await preview(profile), result);
});

test('native template nodes, policies and single final survive managed renames and template namespace collisions', async () => {
  const source = await add('/qx-native', ['https://unused.example/dns-query']);
  await api(`/nodes/${source.nodes[0].id}`, 'PUT', { name: 'Original QX' });
  const managed = (await api('/groups', 'POST', { name: 'Managed QX', type: 'select', proxies: [`node:${source.nodes[0].id}`, 'DIRECT'] })).data;
  const content = '[general]\nfallback_udp_policy = Original QX\n\n' + dns + '[server_local]\nsocks5=192.0.2.8:1080, udp-relay=true, tag=Native\n\n[policy]\nstatic = Choice, Native, direct\nstatic = Bound, Original QX, Managed QX\nssid = Wifi, Original QX, LINK_TEST:Managed QX\n\n[filter_remote]\nhttps://rules.example/retained.list, tag=kept, force-policy=Managed QX\n\n[filter_local]\nhost, retained.example, Choice\nhost, managed.example, Original QX, no-resolve\nfinal, Choice\n';
  const { profile, tpl } = await profileFor([source], content, undefined, [managed]);
  await api(`/nodes/${source.nodes[0].id}`, 'PUT', { name: 'Native' });
  await api(`/groups/${managed.id}`, 'PUT', { ...managed, name: 'Choice' });
  const result = await preview(profile); assert.equal(result.success, true, JSON.stringify(result));
  if (process.env.SUBONE_QX_ARTIFACT) await writeFile(process.env.SUBONE_QX_ARTIFACT, result.data);
  assert.match(result.data, /^socks5=192\.0\.2\.8:1080, udp-relay=true, tag=Native$/m);
  assert.match(result.data, /^socks5=qx-native\.node\.example:1080,.*tag=Native \(2\)$/m);
  assert.match(result.data, /^static = Choice, Native, direct$/m);
  assert.match(result.data, /^static = Bound, Native \(2\), Choice \(2\)$/m);
  assert.match(result.data, /^ssid = Wifi, Native \(2\), LINK_TEST:Choice \(2\)$/m);
  assert.match(result.data, /^fallback_udp_policy = Native \(2\)$/m);
  assert.match(result.data, /^host, managed\.example, Native \(2\), no-resolve$/m);
  assert.match(result.data, /rules\.example\/retained\.list, tag=kept, force-policy=Choice \(2\)/);
  assert.deepEqual(result.data.match(/^final, .+$/gm), ['final, Choice']);
  assert.equal(dnsSection(result.data).replace(/^doh-server\s*=\s*\/.*\n/gm, ''), dns);
  assert.equal((await api('/templates')).data.find((value: any) => value.id === tpl.id).content, content);
  assert.equal(await fetch(`${origin}/s/${profile.token}/quantumultx?expand=true`).then(response => response.text()), result.data);
  const provider = await fetch(`${origin}/s/${profile.token}/source/${source.id}?target=quantumultx`).then(response => response.text());
  assert.match(provider, /tag=Native \(2\)$/m); assert.doesNotMatch(provider, /192\.0\.2\.8/);
  await stopApp(); await startApp(); assert.deepEqual(await preview(profile), result);
});

test('provider and expanded output use the same selected names and usage without raw upstream or unused DNS dependencies', async () => {
  const a = await add('/qx-provider-a', ['https://unused.example/dns-query#Hidden exit'], { proxies: [
    { name: 'A=1', type: 'socks5', server: 'a.provider.example', port: 1080 },
    { name: 'Hidden exit', type: 'socks5', server: 'hidden.provider.example', port: 1080 },
    { name: 'Omitted', type: 'socks5', server: 'omitted.provider.example', port: 1080 },
  ] });
  const b = await add('/qx-provider-b', ['https://other.example/dns-query'], { proxies: [{ name: 'A,1', type: 'socks5', server: 'b.provider.example', port: 1080 }] });
  await add('/qx-unused-source', ['https://never-used.example/dns-query#Missing']);
  await api(`/nodes/${a.nodes.find((node: any) => node.name === 'Hidden exit').id}`, 'PUT', { enabled: false });
  const { profile, group } = await profileFor([a, b], template, { mode: 'all', sourceIds: [a.id, b.id], includeRegex: '^A' });
  const expanded = await preview(profile), remote = await preview(profile, false);
  assert.equal(expanded.success, true, JSON.stringify(expanded)); assert.equal(remote.success, true, JSON.stringify(remote));
  assert.equal(expanded.generation.nodeCount, 2); assert.equal(remote.generation.dependencyNodeCount, 0);
  const names = [...expanded.data.matchAll(/^socks5=.*tag=([^\n]+)$/gm)].map(match => match[1]).sort();
  assert.deepEqual(names, ['A_1', 'A_1 (2)']);
  assert.match(expanded.data, new RegExp(`^static=${group.name}, (?:A_1, A_1 \\(2\\)|A_1 \\(2\\), A_1)(?:,|$)`, 'm'));
  assert.doesNotMatch(expanded.data, /hidden\.provider|omitted\.provider|unused-source/);
  const actual = await fetch(`${origin}/s/${profile.token}/quantumultx`); assert.equal(await actual.text(), expanded.data);
  assert.match(actual.headers.get('subscription-userinfo') || '', /total=2000/);
  assert.equal(await fetch(`${origin}/s/${profile.token}/qx?expand=false`).then(response => response.text()), remote.data);
  assert.doesNotMatch(remote.data, new RegExp(upstreamOrigin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(remote.data, /qx-provider-[ab]|\/source\//);
  const urls = [...remote.data.matchAll(/^(https?:\/\/[^,]+), tag=/gm)].map(match => match[1]).filter(url => url.endsWith('/nodes/qx'));
  assert.deepEqual(urls, []);
  assert.equal(remote.data, expanded.data);
  const resourceUrl = `${origin}/s/${profile.token}/nodes/qx`;
  const providerNames: string[] = [];
  for (const url of [resourceUrl]) {
    const response = await fetch(url); assert.equal(response.status, 200); const content = await response.text();
    assert.doesNotMatch(content, /\[dns\]|doh|hidden\.provider|omitted\.provider/);
    providerNames.push(...[...content.matchAll(/tag=([^\n]+)$/gm)].map(match => match[1]));
  }
  assert.deepEqual(providerNames.sort(), names);
  assert.equal((await fetch(`${origin}/s/invalid-token/nodes/qx`)).status, 404);
  await api(`/profiles/${profile.id}`, 'PUT', { enabled: false });
  assert.equal((await fetch(resourceUrl)).status, 404);
});

test('retained native references report disabled and deleted managed targets instead of retargeting', async () => {
  const source = await add('/qx-repair', []);
  await api(`/nodes/${source.nodes[0].id}`, 'PUT', { name: 'Repair QX' });
  const content = template.replace('[policy]\n', '[policy]\nstatic = Native repair, Repair QX, direct\n').replace('final, direct', 'host, retained.example, Repair QX\nfinal, Native repair');
  const { profile } = await profileFor([source], content);
  assert.equal((await preview(profile)).success, true);
  await api(`/nodes/${source.nodes[0].id}`, 'PUT', { enabled: false });
  const disabled = await preview(profile); assert.equal(disabled.status, 422, JSON.stringify(disabled));
  assert.ok(disabled.generation.diagnostics.some((entry: any) => entry.code === 'quantumultx-reference-missing' && /Native repair|retained.example/.test(entry.message)));
  const actual = await fetch(`${origin}/s/${profile.token}/quantumultx?expand=true`); assert.equal(actual.status, 422); assert.deepEqual((await actual.json() as any).generation, disabled.generation);
  await api(`/nodes/${source.nodes[0].id}`, 'PUT', { enabled: true }); assert.equal((await preview(profile)).success, true);
  await api(`/sources/${source.id}`, 'DELETE');
  const removed = await preview(profile); assert.equal(removed.status, 422);
  const lookalike = await add('/qx-lookalike', []); await api(`/nodes/${lookalike.nodes[0].id}`, 'PUT', { name: 'Repair QX' });
  await stopApp(); await startApp(); assert.equal((await preview(profile)).status, 422);
});

test('native policy cycles are checked through every selectable member after adaptation', async () => {
  const source = await add('/qx-cycle', ['https://unapplied.example/dns-query#Missing']);
  const content = template.replace('[policy]\n', '[policy]\nstatic = Outer, direct, Inner\nstatic = Inner, direct, Outer\n').replace('final, direct', 'final, Outer');
  const { profile } = await profileFor([source], content);
  const result = await preview(profile); assert.equal(result.status, 422, JSON.stringify(result));
  const diagnostic = result.generation.diagnostics.find((entry: any) => entry.code === 'quantumultx-policy-cycle');
  assert.ok(diagnostic, JSON.stringify(result)); assert.match(diagnostic.message, /Outer.*Inner.*Outer/); assert.ok(diagnostic.path.length >= 3);
  const actual = await fetch(`${origin}/s/${profile.token}/quantumultx?expand=true`); assert.equal(actual.status, 422); assert.deepEqual((await actual.json() as any).generation, result.generation);
});

test('native supported protocols and source-mounted policy membership remain valid in expanded and provider output', async () => {
  const path = '/qx-protocols';
  bodies.set(path, '[dns]\ndoh-server = https://source-protocol.example/dns-query\n[server_local]\n' + [
    'shadowsocks=ss.example:443, method=aes-128-gcm, password=p, tag=QX SS',
    'shadowsocks=ssr.example:443, method=aes-128-gcm, password=p, ssr-protocol=auth_chain_a, obfs=tls1.2_ticket_auth, tag=QX SSR',
    'vmess=vmess.example:443, method=none, password=11111111-1111-4111-8111-111111111111, obfs=wss, obfs-host=vmess.example, obfs-uri=/ws, tag=QX VMess',
    'vless=vless.example:443, method=none, password=11111111-1111-4111-8111-111111111111, obfs=wss, obfs-host=vless.example, obfs-uri=/vless, tag=QX VLESS',
    'trojan=trojan.example:443, password=p, over-tls=true, tls-host=trojan.example, tls-verification=false, tag=QX Trojan',
    'socks5=[2001:db8::8]:1080, username=u, password=p, tag=QX SOCKS',
    'http=http.example:443, username=u, password=p, over-tls=true, tls-host=http.example, tag=QX HTTP',
    'anytls=anytls.example:443, password=p, over-tls=true, tls-host=anytls.example, tag=QX AnyTLS',
  ].join('\n'));
  const added = await api('/sources', 'POST', { name: 'QX Protocol source', url: upstreamOrigin + path }); assert.equal(added.success, true, JSON.stringify(added)); const source = added.data;
  const other = await add('/qx-protocol-other', [], { proxies: [{ name: 'QX Other', type: 'socks5', server: 'qx-other.example', port: 1080 }] });
  const group = (await api('/groups', 'POST', { name: 'Mounted QX', type: 'select', sources: [source.id], filter: '^QX ' })).data;
  const { profile } = await profileFor([source, other], template, undefined, [group]);
  const result = await preview(profile); assert.equal(result.success, true, JSON.stringify(result));
  const policy = result.data.split('\n').find((line: string) => line.startsWith('static=Mounted QX,')); assert.ok(policy);
  for (const name of ['QX SS', 'QX SSR', 'QX VMess', 'QX VLESS', 'QX Trojan', 'QX SOCKS', 'QX HTTP', 'QX AnyTLS']) assert.ok(policy.includes(name), policy);
  assert.doesNotMatch(policy, /QX Other/);
  assert.match(result.data, /^shadowsocks=ssr\.example:443,.*ssr-protocol=auth_chain_a, obfs=tls1\.2_ticket_auth.*tag=QX SSR$/m);
  assert.match(result.data, /^vmess=vmess\.example:443,.*obfs=wss, obfs-host=vmess\.example, obfs-uri=\/ws.*tag=QX VMess$/m);
  assert.match(result.data, /^vless=vless\.example:443,.*obfs=wss, obfs-host=vless\.example, obfs-uri=\/vless.*tag=QX VLESS$/m);
  assert.match(result.data, /^trojan=trojan\.example:443,.*tls-host=trojan\.example, tls-verification=false.*tag=QX Trojan$/m);
  assert.match(result.data, /^socks5=\[2001:db8::8\]:1080, username=u, password=p.*tag=QX SOCKS$/m);
  assert.match(result.data, /^http=http\.example:443, username=u, password=p, over-tls=true, tls-host=http\.example.*tag=QX HTTP$/m);
  assert.match(result.data, /^anytls=anytls\.example:443,.*over-tls=true, tls-host=anytls\.example.*tag=QX AnyTLS$/m);
  const provider = await fetch(`${origin}/s/${profile.token}/source/${source.id}?target=quantumultx`).then(response => response.text());
  assert.equal(provider.split('\n').filter(Boolean).length, 8); assert.doesNotMatch(provider, /doh-server|\[dns\]|QX Other/);
});

test('unapplied source DNS does not conceal an unrepresentable ordinary node connection chain in full or node-only output', async () => {
  const source = await add('/qx-node-chain', ['https://unused.example/dns-query#Missing DNS exit'], { proxies: [
    { name: 'Chain QX', type: 'socks5', server: 'chain.node.example', port: 1080, 'dialer-proxy': 'Chain exit' },
    { name: 'Chain exit', type: 'socks5', server: '192.0.2.22', port: 1080 },
  ] });
  const { profile } = await profileFor([source], template, { mode: 'manual', selectedNodeIds: [source.nodes[0].id] });
  const result = await preview(profile); assert.equal(result.status, 422, JSON.stringify(result));
  assert.ok(result.generation.diagnostics.some((entry: any) => entry.code === 'quantumultx-node-chain-unverified' && /Chain QX/.test(entry.message)));
  assert.equal(result.generation.dependencyNodeCount, 0);
  const provider = await fetch(`${origin}/s/${profile.token}/source/${source.id}?target=quantumultx`); assert.equal(provider.status, 422);
  const metadata = await provider.json() as any;
  assert.ok(metadata.generation.diagnostics.some((entry: any) => entry.code === 'quantumultx-node-chain-unverified'));
  assert.ok(metadata.generation.bindings.every((binding: any) => binding.services.length === 0 && binding.method === 'nodes-only' && binding.status === 'ignored'));
});

test('failed update retains all saved source intent and successful DoH removal keeps template DNS after reload', async () => {
  const path = '/qx-lifecycle';
  const body = { outbounds: [
    { type: 'socks', tag: 'Lifecycle QX', server: 'lifecycle.node.example', server_port: 1080 },
    { type: 'socks', tag: 'DNS exit QX', server: 'dns-exit.example', server_port: 1080 },
  ], dns: { servers: [
    { type: 'https', tag: 'one', server: 'first.lifecycle.example', path: '/dns-query', headers: { 'X-Custom': 'source header' }, tls: { server_name: 'first.lifecycle.example' }, detour: 'DNS exit QX', domain_resolver: { server: 'one' } },
    { type: 'https', tag: 'two', server: 'second.lifecycle.example', path: '/resolve', detour: 'Missing exit' },
  ] } };
  bodies.set(path, JSON.stringify(body));
  const created = await api('/sources', 'POST', { name: 'Lifecycle QX source', url: upstreamOrigin + path }); assert.equal(created.success, true, JSON.stringify(created)); const source = created.data;
  const ordinary = source.nodes.find((node: any) => node.name === 'Lifecycle QX'), exit = source.nodes.find((node: any) => node.name === 'DNS exit QX');
  await api(`/nodes/${exit.id}`, 'PUT', { enabled: false });
  const { profile } = await profileFor([source], template, { mode: 'manual', selectedNodeIds: [ordinary.id] });
  const initial = await preview(profile); assert.equal(initial.success, true, JSON.stringify(initial)); assert.equal(initial.generation.dependencyNodeCount, 0); assert.equal(dnsSection(initial.data), dns);
  assert.equal(initial.generation.bindings[0].status, 'unapplied');
  bodies.set(path, '{broken json'); assert.equal((await api(`/sources/${source.id}/refresh`, 'POST')).success, false);
  const failed = (await api('/sources')).data.find((entry: any) => entry.id === source.id); assert.deepEqual(failed.doh, source.doh);
  assert.deepEqual((await preview(profile)).generation, initial.generation);
  assert.equal((await api(`/sources/${source.id}/raw`)).data.content, '{broken json');
  await stopApp(); await startApp(); assert.deepEqual((await api('/sources')).data.find((entry: any) => entry.id === source.id).doh, source.doh);
  bodies.set(path, JSON.stringify({ outbounds: body.outbounds })); assert.equal((await api(`/sources/${source.id}/refresh`, 'POST')).success, true);
  const removed = await preview(profile); assert.equal(removed.success, true, JSON.stringify(removed)); assert.equal(dnsSection(removed.data), dns);
  assert.equal(removed.generation.bindings[0].status, 'template'); assert.equal(removed.generation.bindings[0].method, 'template-dns'); assert.deepEqual(removed.generation.bindings[0].services, []);
  assert.notEqual(removed.generation.bindings[0].batchId, source.doh.batchId); assert.deepEqual(removed.generation.diagnostics, []);
  assert.equal(await fetch(`${origin}/s/${profile.token}/quantumultx?expand=true`).then(response => response.text()), removed.data);
  await stopApp(); await startApp(); assert.deepEqual(await preview(profile), removed);
  await api(`/sources/${source.id}`, 'PUT', { ...failed, enabled: false });
  const disabled = await preview(profile, false); assert.equal(disabled.success, true, JSON.stringify(disabled)); assert.equal(disabled.generation.nodeCount, 0); assert.deepEqual(disabled.generation.bindings, []);
  assert.equal((await fetch(`${origin}/s/${profile.token}/source/${source.id}?target=quantumultx`)).status, 404);
});

test('a native rule cannot reference a node emitted only as an unsupported protocol comment', async () => {
  const source = await add('/qx-unsupported', [], { proxies: [{ name: 'Unsupported QX', type: 'hysteria2', server: 'unsupported.example', port: 443, password: 'p' }] });
  const content = template.replace('final, direct', 'host, unsupported-target.example, Unsupported QX\nfinal, direct');
  const { profile } = await profileFor([source], content);
  const result = await preview(profile); assert.equal(result.status, 422, JSON.stringify(result));
  assert.ok(result.generation.diagnostics.some((entry: any) => entry.code === 'quantumultx-reference-missing' && /Unsupported QX/.test(entry.message)));
});

test('retained native template references complete eligible omitted nodes and groups without entering ordinary candidates or usage', async () => {
  const a = await add('/qx-closure-ordinary', [], { proxies: [{ name: 'Ordinary closure QX', type: 'socks5', server: 'ordinary.closure.example', port: 1080 }] });
  const b = await add('/qx-closure-dependency', ['https://unused.closure.example/dns-query#Missing'], { proxies: [{ name: 'Dependency closure QX', type: 'socks5', server: 'dependency.closure.example', port: 1080 }] });
  const dependency = (await api('/groups', 'POST', { name: 'Dependency group QX', type: 'select', proxies: ['DIRECT'] })).data;
  const content = template.replace('[policy]\n', '[policy]\nstatic = Native closure, Dependency group QX, Dependency closure QX, direct\n').replace('final, direct', 'final, Native closure');
  const { profile, group } = await profileFor([a], content, { mode: 'manual', selectedNodeIds: [a.nodes[0].id] });
  const result = await preview(profile, false); assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.generation.nodeCount, 1); assert.equal(result.generation.dependencyNodeCount, 1);
  assert.deepEqual(result.generation.dependencyNodes.map((node: any) => node.id), [b.nodes[0].id]);
  assert.match(result.data, /^socks5=dependency\.closure\.example:1080,.*tag=Dependency closure QX$/m);
  assert.match(result.data, /^static=Dependency group QX, direct(?:,|$)/m);
  assert.match(result.data, /^static = Native closure, Dependency group QX, Dependency closure QX, direct$/m);
  const ordinaryPolicy = result.data.split('\n').find((line: string) => line.startsWith(`static=${group.name},`)); assert.doesNotMatch(ordinaryPolicy, /Dependency closure/); assert.match(ordinaryPolicy, /, Ordinary closure QX(?:,|$)/);
  const actual = await fetch(`${origin}/s/${profile.token}/quantumultx?expand=false`); assert.equal(await actual.text(), result.data); assert.match(actual.headers.get('subscription-userinfo') || '', /total=1000/);
  const urls = [...result.data.matchAll(/^(https?:\/\/[^,]+), tag=/gm)].map(match => match[1]).filter(url => url.endsWith('/nodes/qx')); assert.equal(urls.length, 0);
  const provider = await fetch(`${origin}/s/${profile.token}/nodes/qx`).then(response => response.text()); assert.match(provider, /ordinary\.closure/); assert.doesNotMatch(provider, /dependency\.closure/);
  const previousOrigin = origin; await stopApp(); await startApp(); const reloaded = await preview(profile, false); assert.deepEqual(reloaded.generation, result.generation); assert.equal(reloaded.data.replaceAll(origin, previousOrigin), result.data);
  await api(`/nodes/${b.nodes[0].id}`, 'PUT', { enabled: false }); const disabled = await preview(profile, false); assert.equal(disabled.status, 422, JSON.stringify(disabled));
  assert.ok(disabled.generation.diagnostics.some((entry: any) => entry.code === 'quantumultx-reference-missing'));
});


test('an ordinary FINAL selector cannot pull profile-excluded mounted source nodes through template closure', async () => {
  const a = await add('/qx-final-ordinary', [], { proxies: [{ name: 'Final ordinary QX', type: 'socks5', server: 'ordinary.final.example', port: 1080 }] });
  const b = await add('/qx-final-excluded', [], { proxies: [{ name: 'Excluded final QX', type: 'socks5', server: 'excluded.final.example', port: 1080 }] });
  const group = (await api('/groups', 'POST', { name: 'Empty ordinary final QX', type: 'select', sources: [b.id] })).data;
  const content = template.replace('final, direct', 'final, Empty ordinary final QX');
  const { profile } = await profileFor([a], content, { mode: 'manual', selectedNodeIds: [a.nodes[0].id] });
  const result = await preview(profile, false); assert.equal(result.status, 422, JSON.stringify(result));
  assert.equal(result.generation.nodeCount, 1); assert.equal(result.generation.dependencyNodeCount, 0);
  assert.ok(result.generation.diagnostics.some((entry: any) => entry.code === 'quantumultx-reference-missing' && entry.message.includes(group.name)));
  const provider = await fetch(`${origin}/s/${profile.token}/source/${a.id}?target=quantumultx`).then(response => response.text()); assert.match(provider, /ordinary.final.example/); assert.doesNotMatch(provider, /excluded.final.example/);
});

test('the official native proxy policy namespace does not retarget to a managed node named proxy', async () => {
  const source = await add('/qx-native-proxy', [], { proxies: [{ name: 'proxy', type: 'socks5', server: 'managed.proxy.example', port: 1080 }] });
  const { profile } = await profileFor([source], template.replace('final, direct', 'final, proxy'));
  const result = await preview(profile); assert.equal(result.success, true, JSON.stringify(result));
  assert.match(result.data, /^socks5=managed\.proxy\.example:1080,.*tag=proxy \(2\)$/m);
  assert.deepEqual(result.data.match(/^final, .+$/gm), ['final, proxy']);
});

test('ambiguous native outbound definitions reject instead of silently picking a template declaration', async () => {
  const source = await add('/qx-native-duplicate', []);
  const content = template.replace('[server_local]\n', '[server_local]\nsocks5=192.0.2.1:1080, tag=Duplicate native\nsocks5=192.0.2.2:1080, tag=Duplicate native\n').replace('final, direct', 'final, Duplicate native');
  const { profile } = await profileFor([source], content);
  const result = await preview(profile); assert.equal(result.status, 422, JSON.stringify(result));
  assert.ok(result.generation.diagnostics.some((entry: any) => entry.code === 'quantumultx-reference-ambiguous' && /Duplicate native/.test(entry.message)));
});

test('template-owned dynamic policies refuse unverified dependency candidate isolation', async () => {
  const a = await add('/qx-dynamic-ordinary', [], { proxies: [{ name: 'Dynamic ordinary QX', type: 'socks5', server: 'ordinary.dynamic.example', port: 1080 }] });
  const b = await add('/qx-dynamic-dependency', [], { proxies: [{ name: 'Dynamic dependency QX', type: 'socks5', server: 'dependency.dynamic.example', port: 1080 }] });
  const content = template.replace('[policy]\n', '[policy]\nstatic = Native dynamic QX, server-tag-regex=.*\nstatic = Native required QX, Dynamic dependency QX\n');
  const { profile } = await profileFor([a], content);
  const result = await preview(profile, false); assert.equal(result.status, 422, JSON.stringify(result));
  assert.equal(result.generation.dependencyNodeCount, 1);
  assert.ok(result.generation.diagnostics.some((entry: any) => entry.code === 'quantumultx-candidate-isolation-unverified' && entry.severity === 'error' && /Native dynamic QX/.test(entry.message)));
  const actual = await fetch(`${origin}/s/${profile.token}/quantumultx`);
  assert.equal(actual.status, 422);
  assert.deepEqual((await actual.json() as any).generation, result.generation);
  const provider = await fetch(`${origin}/s/${profile.token}/source/${a.id}?target=quantumultx`);
  assert.equal(provider.status, 200);
  assert.match(await provider.text(), /ordinary.dynamic.example/);
  assert.equal((await api('/sources')).data.find((source: any) => source.id === b.id).nodes[0].name, 'Dynamic dependency QX');
});
