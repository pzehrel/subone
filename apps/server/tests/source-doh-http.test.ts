import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

let directory: string;
let child: ChildProcess;
let origin: string;
let upstreamOrigin: string;
const bodies = new Map<string, string>();
const upstream = createServer((request, response) => response.end(bodies.get(request.url || '/') || 'proxies: []'));
async function startApp() {
  child = spawn(process.execPath, ['--import', 'tsx', join(__dirname, 'helpers/http-server.ts')], {
    env: { ...process.env, SUBONE_ROOT: directory }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let errors = '';
  child.stderr?.on('data', chunk => { errors += chunk; });
  const message = await Promise.race([once(child, 'message'), once(child, 'exit').then(([code]) => { throw new Error(`Server exited ${code}: ${errors}`); })]);
  origin = `http://127.0.0.1:${message[0].port}`;
}
async function stopApp() { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; }
async function api(path: string, method = 'GET', value?: unknown) {
  const response = await fetch(`${origin}/api${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: value === undefined ? undefined : JSON.stringify(value) });
  return { status: response.status, ...(await response.json() as any) };
}
async function source(id: string) { return (await api('/sources')).data.find((entry: any) => entry.id === id); }
const node = ' - {name: First, type: ss, server: node.example, port: 443, cipher: aes-128-gcm, password: secret}\n';
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'subone-doh-http-'));
  await writeFile(join(directory, 'config.json'), JSON.stringify({ port: 3456, adminPassword: '' }));
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const address = upstream.address(); assert.ok(address && typeof address !== 'string');
  upstreamOrigin = `http://127.0.0.1:${address.port}`; await startApp();
});
after(async () => { await stopApp(); await new Promise<void>(resolve => upstream.close(() => resolve())); await rm(directory, { recursive: true, force: true }); });

test('Mihomo source keeps every DoH in input order and automatically binds all source nodes after reload', async () => {
  const raw = `# full upstream\nproxies:\n${node}dns:\n fallback: ['https://second.example/dns-query#DIRECT', tls://dot.example]\n nameserver: [192.0.2.53, 'https://first.example/custom?token=kept#DIRECT', 'https://second.example/dns-query#DIRECT']\n nameserver-policy:\n  '+.example': https://policy.example/dns-query\nproxy-groups:\n - {name: Ordinary, type: select, proxies: [DIRECT]}\n`;
  bodies.set('/mihomo', raw);
  const created = await api('/sources', 'POST', { name: 'Mihomo DoH', url: `${upstreamOrigin}/mihomo` });
  assert.equal(created.success, true);
  const saved = await source(created.data.id);
  assert.deepEqual(saved.doh.services.map((entry: any) => entry.url), ['https://second.example/dns-query', 'https://first.example/custom?token=kept', 'https://second.example/dns-query', 'https://policy.example/dns-query']);
  assert.equal(saved.doh.sourceId, saved.id);
  assert.equal(saved.doh.updatedAt, saved.lastUpdated);
  assert.equal(saved.doh.services[0].raw, 'https://second.example/dns-query#DIRECT');
  assert.deepEqual(saved.doh.services[0].outbound, { kind: 'direct', name: 'DIRECT' });
  assert.ok(saved.nodes.every((entry: any) => entry.sourceId === saved.doh.sourceId));
  assert.equal((await api(`/sources/${saved.id}/raw`)).data.content, raw);
  await stopApp(); await startApp();
  assert.deepEqual((await source(saved.id)).doh, saved.doh);
});

test('a malformed DoH target fails the entire update and first add while successful replacement and removal are source-local', async () => {
  const originalRaw = `proxies:\n${node}dns:\n nameserver: [https://old.example/dns-query]\n`;
  bodies.set('/changing', originalRaw); bodies.set('/isolated', originalRaw);
  const a = (await api('/sources', 'POST', { name: 'Changing', url: `${upstreamOrigin}/changing` })).data;
  const b = (await api('/sources', 'POST', { name: 'Isolated', url: `${upstreamOrigin}/isolated` })).data;
  for (const malformed of ['https:/missing-slash.example/dns-query', 'https://', 'https://dns.example:70000/dns-query', 'https://dns.example/dns query', 'https://dns.example\\evil/dns-query']) {
    const failedRaw = `proxies:\n${node.replace('First', 'Must not publish')}dns:\n nameserver: [https://valid.example/dns-query, '${malformed}']\n`;
    bodies.set('/changing', failedRaw);
    assert.equal((await api(`/sources/${a.id}/refresh`, 'POST', {})).success, false, malformed);
    const retained = await source(a.id);
    assert.deepEqual(retained.nodes, a.nodes, malformed);
    assert.deepEqual(retained.doh, a.doh, malformed);
    assert.equal(retained.lastUpdated, a.lastUpdated);
    const raw = (await api(`/sources/${a.id}/raw`)).data;
    assert.equal(raw.content, failedRaw);
    assert.equal(raw.parseStatus, 'failed');
    const first = await api('/sources', 'POST', { name: 'Failed DoH', url: `${upstreamOrigin}/changing`, createGroup: true });
    assert.equal(first.success, false, malformed);
    assert.equal((await api('/config')).data.sources.some((entry: any) => entry.name === 'Failed DoH'), false);
  }
  bodies.set('/changing', `proxies:\n${node}${node.replace('First', 'Added').replace('node.example', 'added.example')}dns:\n nameserver: [https://replacement.example/dns-query]\n`);
  assert.equal((await api(`/sources/${a.id}/refresh`, 'POST', {})).success, true);
  const replacement = await source(a.id);
  assert.equal(replacement.nodes.length, 2);
  assert.equal(replacement.doh.services[0].url, 'https://replacement.example/dns-query');
  assert.notEqual(replacement.doh.batchId, a.doh.batchId);
  assert.ok(replacement.nodes.every((entry: any) => entry.sourceId === replacement.doh.sourceId));
  bodies.set('/changing', `proxies:\n${node}dns:\n nameserver: [192.0.2.53, tls://dot.example]\n`);
  assert.equal((await api(`/sources/${a.id}/refresh`, 'POST', {})).success, true);
  assert.deepEqual((await source(a.id)).doh.services, []);
  assert.deepEqual((await source(b.id)).doh, b.doh);
  await stopApp(); await startApp();
  assert.deepEqual((await source(a.id)).doh.services, []);
  assert.deepEqual((await source(b.id)).doh, b.doh);
});

test('sing-box preserves legacy and typed HTTPS connection intent and rejects incomplete HTTPS targets', async () => {
  const legacy = { tag: 'legacy', address: 'https://legacy.example/custom?token=one', address_resolver: 'bootstrap', address_strategy: 'prefer_ipv6', detour: 'Exit', strategy: 'ipv4_only' };
  const typed = { type: 'https', tag: 'typed', server: 'typed.example', server_port: 8443, path: '/query?token=two', headers: { Authorization: ['Bearer kept'] }, tls: { server_name: 'tls.example', insecure: false }, detour: 'Route', domain_resolver: { server: 'bootstrap', strategy: 'ipv4_only' } };
  const minimal = { type: 'https', server: '192.0.2.53' };
  const content = { outbounds: [{ type: 'shadowsocks', tag: 'Exit', server: 'node.example', server_port: 443, method: 'aes-128-gcm', password: 'secret' }, { type: 'selector', tag: 'Route', outbounds: ['Exit', 'direct'] }, { type: 'direct', tag: 'direct' }], dns: { servers: [legacy, { type: 'tls', server: 'dot.example' }, typed, minimal, { address: '192.0.2.53' }] } };
  bodies.set('/singbox', JSON.stringify(content));
  const created = await api('/sources', 'POST', { name: 'Sing-box DoH', url: `${upstreamOrigin}/singbox` });
  assert.equal(created.success, true);
  const saved = await source(created.data.id);
  assert.deepEqual(saved.doh.services.map((entry: any) => entry.url), ['https://legacy.example/custom?token=one', 'https://typed.example:8443/query?token=two', 'https://192.0.2.53/dns-query']);
  assert.deepEqual(saved.doh.services.map((entry: any) => entry.raw), [legacy, typed, minimal]);
  assert.deepEqual(saved.doh.services[2].outbound, { kind: 'direct' });
  const invalid = [{ type: 'https' }, { type: 'https', server: 'https://invalid.example' }, { type: 'https', server: 'valid.example', server_port: 65536 }, { type: 'https', server: 'valid.example', path: 123 }, { tag: 'broken', address: 'https:/invalid.example' }];
  for (const target of invalid) {
    bodies.set('/singbox', JSON.stringify({ ...content, dns: { servers: [legacy, target] } }));
    const failed = await api(`/sources/${saved.id}/refresh`, 'POST', {});
    assert.equal(failed.success, false, JSON.stringify(target));
    assert.deepEqual((await source(saved.id)).doh, saved.doh);
    assert.equal((await api(`/sources/${saved.id}/raw`)).data.parseStatus, 'failed');
  }
});

test('QuanX DNS entries preserve every endpoint, domain scope and SSID option through Base64 input', async () => {
  const raw = '# full QuanX\n[server_local]\nshadowsocks=node.example:443, method=aes-128-gcm, password=secret, tag=First\n[dns]\nserver = 192.0.2.53\ndoh-server = https://one.example/dns-query, https://two.example/query, included_ssids="Office, Guest"\ndoh-server = /*.internal.example/https://scoped.example/query, excluded_ssids=Mobile\n[policy]\nstatic=ordinary, First, direct\n';
  bodies.set('/quanx', Buffer.from(raw).toString('base64'));
  const created = await api('/sources', 'POST', { name: 'QuanX DoH', url: `${upstreamOrigin}/quanx` });
  assert.equal(created.success, true);
  const saved = await source(created.data.id);
  assert.equal(saved.detectedFormat, 'quantumultx');
  assert.deepEqual(saved.doh.services.map((entry: any) => entry.url), ['https://one.example/dns-query', 'https://two.example/query', 'https://scoped.example/query']);
  assert.deepEqual(saved.doh.services[2].raw, { line: 'doh-server = /*.internal.example/https://scoped.example/query, excluded_ssids=Mobile', value: '/*.internal.example/https://scoped.example/query', scope: '/*.internal.example/', options: ['excluded_ssids=Mobile'] });
  assert.equal(saved.doh.services[0].raw.options[0], 'included_ssids="Office, Guest"');
  assert.equal((await api(`/sources/${saved.id}/raw`)).data.content, Buffer.from(raw).toString('base64'));
  for (const malformed of ['https:/broken.example/query', 'https://', 'https://good.example/query, https:/broken.example/query', '']) {
    bodies.set('/quanx', `[dns]\ndoh-server = ${malformed}\n`);
    assert.equal((await api(`/sources/${saved.id}/refresh`, 'POST', {})).success, false, malformed);
    assert.deepEqual((await source(saved.id)).doh, saved.doh);
  }
  bodies.set('/dns-only', '# comment\n  [ dns ]\ndoh-server = https://only.example/dns-query\nserver = tls://ordinary.example\n');
  const dnsOnly = await api('/sources', 'POST', { name: 'DNS only', url: `${upstreamOrigin}/dns-only` });
  assert.equal(dnsOnly.success, true);
  assert.equal(dnsOnly.data.nodeCount, 0);
  assert.deepEqual(dnsOnly.data.doh.services.map((entry: any) => entry.url), ['https://only.example/dns-query']);
});
