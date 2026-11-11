import assert from 'node:assert/strict';
import yaml from 'js-yaml';
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
const sourceHeaders = new Map<string, string>();
const upstream = createServer((request, response) => {
  const userinfo = sourceHeaders.get(request.url || '/');
  if (userinfo) response.setHeader('subscription-userinfo', userinfo);
  response.end(bodies.get(request.url || '/') || 'proxies: []');
});
async function startApp() {
  child = spawn(process.execPath, ['--import', 'tsx', join(__dirname, 'helpers/http-server.ts')], { env: { ...process.env, SUBONE_ROOT: directory }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let errors = ''; child.stderr?.on('data', chunk => { errors += chunk; });
  const message = await Promise.race([once(child, 'message'), once(child, 'exit').then(([code]) => { throw new Error(`Server exited ${code}: ${errors}`); })]);
  origin = `http://127.0.0.1:${message[0].port}`;
}
async function stopApp() { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; }
async function api(path: string, method = 'GET', value?: unknown) {
  const response = await fetch(`${origin}/api${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: value === undefined ? undefined : JSON.stringify(value) });
  return { status: response.status, ...(await response.json() as any) };
}
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'subone-shadowrocket-http-'));
  await writeFile(join(directory, 'config.json'), JSON.stringify({ port: 3456, adminPassword: '' }));
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const address = upstream.address(); assert.ok(address && typeof address !== 'string'); upstreamOrigin = `http://127.0.0.1:${address.port}`; await startApp();
});
after(async () => { await stopApp(); await new Promise<void>(resolve => upstream.close(() => resolve())); await rm(directory, { recursive: true, force: true }); });
const template = '[General]\ndns-server = system,192.0.2.53\ndoh-server = https://ordinary.example/dns-query\nallow-wifi-access = false\n\n[Host]\nkept.example = 192.0.2.10\n\n[Proxy]\n\n[Proxy Group]\n\n[Rule]\nDOMAIN,kept.example,DIRECT\n';
async function addSource(path: string, dns: unknown[], server: string) {
  bodies.set(path, yaml.dump({ proxies: [{ name: 'Shared', type: 'trojan', password: 'secret', server, port: 1080 }], dns: { nameserver: dns } }));
  const response = await api('/sources', 'POST', { name: path.slice(1), url: upstreamOrigin + path }); assert.equal(response.success, true, response.message); return response.data;
}
async function profileFor(sources: any[], content = template, extra: Record<string, unknown> = {}) {
  const group = (await api('/groups', 'POST', { name: `Candidates-${Math.random()}`, type: 'select', sources: sources.map(source => source.id) })).data;
  const tpl = (await api('/templates', 'POST', { name: 'Shadowrocket template', type: 'shadowrocket', content })).data;
  const rule = (await api('/rules/unified', 'POST', { name: 'Shadowrocket local rule', kind: 'local', type: 'DOMAIN', payload: 'managed-rule.example', outbound: 'DIRECT', enabled: true })).data;
  const response = await api('/profiles', 'POST', { name: 'Shadowrocket profile', nodeFilter: { mode: 'all', sourceIds: sources.map(source => source.id) }, selectedGroupIds: [group.id], selectedRuleIds: [rule.id], templates: { shadowrocket: tpl.id }, ...extra }); assert.equal(response.success, true, response.message); return response.data;
}
function decoded(content: string): string { return Buffer.from(content, 'base64').toString('utf8'); }

test('Shadowrocket adopts each source DoH list in native Host mappings', async () => {
  const a = await addSource('/rocket-a', ['https://192.0.2.1/dns-query', 'https://192.0.2.2/second'], 'node.a.example');
  const b = await addSource('/rocket-b', ['https://192.0.2.3/dns-query'], 'node.b.example');
  const profile = await profileFor([a, b]);
  const preview = await api('/generate/preview', 'POST', { profileId: profile.id, customType: 'shadowrocket' });
  assert.equal(preview.success, true, preview.message);
  assert.deepEqual(preview.generation.target, { type: 'shadowrocket', version: '2.2.93', mode: 'complete' });
  assert.deepEqual(preview.generation.bindings.map((binding: any) => [binding.sourceId, binding.batchId, binding.status, binding.method, binding.services.map((service: any) => service.url), binding.appliedServiceIds]), [
    [a.id, a.doh.batchId, 'applied', 'shadowrocket-domain-doh', a.doh.services.map((service: any) => service.url), a.doh.services.map((service: any) => service.id)],
    [b.id, b.doh.batchId, 'applied', 'shadowrocket-domain-doh', b.doh.services.map((service: any) => service.url), b.doh.services.map((service: any) => service.id)],
  ]);
  assert.ok(preview.data.includes(template.split('[Host]')[0]));
  assert.doesNotMatch(preview.data, /server-dns=|domain_resolver|dns-egress=|bootstrap=/);
  assert.equal(preview.generation.dependencyNodeCount, 0);
  assert.equal(preview.generation.diagnostics.length, 0);
  assert.match(preview.data, /node\.a\.example = server:https:\/\/192.0.2.1\/dns-query,https:\/\/192.0.2.2\/second/);
  if (process.env.SUBONE_SHADOWROCKET_ARTIFACT) await writeFile(process.env.SUBONE_SHADOWROCKET_ARTIFACT, preview.data);
  const actual = await fetch(`${origin}/s/${profile.token}/shadowrocket`);
  assert.equal(actual.status, 200); assert.equal(await actual.text(), preview.data);
  await stopApp(); await startApp();
  assert.equal(await fetch(`${origin}/s/${profile.token}/rocket`).then(response => response.text()), preview.data);
  assert.deepEqual((await api('/sources')).data.find((entry: any) => entry.id === a.id).doh, a.doh);
});

test('pure Base64 and URI source endpoints preserve local punctuation names and ignore every unused DNS graph', async () => {
  bodies.set('/rocket-pure', JSON.stringify({ outbounds: [
    { type: 'trojan', tag: 'Original', server: 'pure.node.example', server_port: 443, password: 'secret' },
    { type: 'trojan', tag: 'DNS exit', server: 'unused.dns.exit.example', server_port: 443, password: 'other' },
  ], dns: { servers: [{ type: 'https', tag: 'cyclic', server: 'broken.dns.example', detour: 'DNS exit', domain_resolver: { server: 'cyclic' } }] } }));
  const source = (await api('/sources', 'POST', { name: 'Pure source', url: upstreamOrigin + '/rocket-pure' })).data;
  const ordinary = source.nodes.find((node: any) => node.server === 'pure.node.example');
  const exit = source.nodes.find((node: any) => node.server === 'unused.dns.exit.example');
  await api(`/nodes/${ordinary.id}`, 'PUT', { name: 'Local, A=B' });
  await api(`/nodes/${exit.id}`, 'PUT', { enabled: false });
  const profile = await profileFor([source], template, { nodeFilter: { mode: 'manual', selectedNodeIds: [ordinary.id] } });
  const invalid = await api('/generate/preview', 'POST', { profileId: profile.id, customType: 'singbox', customTemplate: '{"dns":{"servers":[]},"outbounds":[],"route":{}}' });
  assert.equal(invalid.status, 422);
  const preview = await api('/generate/preview', 'POST', { profileId: profile.id, customType: 'shadowrocket', format: 'base64' });
  assert.equal(preview.success, true, preview.message);
  assert.equal(preview.generation.target.mode, 'nodes');
  assert.equal(preview.generation.nodeCount, 1); assert.equal(preview.generation.dependencyNodeCount, 0);
  assert.equal(preview.generation.bindings[0].status, 'ignored');
  assert.deepEqual(preview.generation.diagnostics, []);
  assert.equal(decoded(preview.data), 'trojan://secret@pure.node.example:443#Local%2C%20A%3DB');
  for (const path of [
    `/s/${profile.token}/shadowrocket?format=base64`, `/s/${profile.token}/rocket?format=b64`,
    `/s/${profile.token}/source/${source.id}?target=shadowrocket`, `/s/${profile.token}/source/${source.id}/rocket`,
    `/s/${profile.token}/source/${source.id}?target=singbox`, `/s/${profile.token}/source/${source.id}/singbox`,
  ]) {
    const response = await fetch(origin + path); assert.equal(response.status, 200, path); assert.equal(await response.text(), preview.data, path);
  }
  const saved = (await api('/sources')).data.find((entry: any) => entry.id === source.id);
  assert.equal(saved.nodes.find((node: any) => node.id === ordinary.id).raw.tag, 'Original');
  assert.deepEqual(saved.doh, source.doh);
  await stopApp(); await startApp();
  assert.equal(await fetch(`${origin}/s/${profile.token}/shadowrocket?format=b64`).then(response => response.text()), preview.data);
});

test('complete Shadowrocket preserves native namespaces and stable managed template references through rename and reload', async () => {
  const source = await addSource('/rocket-native', ['https://192.0.2.10/dns-query'], 'node.native.example');
  const managed = (await api('/groups', 'POST', { name: 'Managed Rocket', type: 'urltest', proxies: [`node:${source.nodes[0].id}`], url: 'https://probe.example/check', interval: 73, tolerance: 19 })).data;
  const content = template.replace('[Proxy]\n', '[Proxy]\nShared = socks5, native.template.example, 1081, udp=false\n')
    .replace('[Proxy Group]\n', '[Proxy Group]\nNative = url-test, Managed Rocket, Shared, url=https://native-probe.example/check, interval=47, tolerance=13\n')
    .replace('DOMAIN,kept.example,DIRECT', 'DOMAIN,kept.example,Native\nDOMAIN,managed.example,Managed Rocket\nFINAL,Native');
  const profile = await profileFor([source], content, { selectedGroupIds: [managed.id] });
  await api(`/groups/${managed.id}`, 'PUT', { ...managed, name: 'Managed Renamed' });
  await api(`/nodes/${source.nodes[0].id}`, 'PUT', { name: 'Shared' });
  const preview = await api('/generate/preview', 'POST', { profileId: profile.id, customType: 'shadowrocket' });
  assert.equal(preview.success, true, preview.message);
  assert.match(preview.data, /^Shared = socks5, native.template.example, 1081, udp=false$/m);
  assert.match(preview.data, /^Shared \(2\) = trojan, node.native.example, 1080,/m);
  assert.match(preview.data, /^Native = url-test, Managed Renamed, Shared, url=https:\/\/native-probe.example\/check, interval=47, tolerance=13$/m);
  assert.match(preview.data, /^Managed Renamed = url-test, Shared \(2\), url=https:\/\/probe.example\/check, interval=73, tolerance=19$/m);
  assert.match(preview.data, /^DOMAIN,managed.example,Managed Renamed$/m);
  assert.match(preview.data, /^FINAL,Native$/m);
  assert.equal((preview.data.match(/^FINAL,/gm) || []).length, 1);
  assert.ok(preview.data.includes(template.split('[Host]')[0]));
  assert.equal((await api('/templates')).data.find((entry: any) => entry.id === profile.templates.shadowrocket).content, content);
  await stopApp(); await startApp();
  assert.equal(await fetch(`${origin}/s/${profile.token}/shadowrocket?expand=false`).then(response => response.text()), preview.data);
});

test('unsupported Shadowrocket DNS cannot hide ordinary node chains while pure entries report the chain boundary', async () => {
  bodies.set('/rocket-chain', JSON.stringify({ outbounds: [
    { type: 'trojan', tag: 'Chained', server: 'chained.node.example', server_port: 443, password: 'secret', detour: 'Absent ordinary exit' },
  ], dns: { servers: [{ type: 'https', server: 'dns.unsupported.example', domain_resolver: { server: 'missing-unused-bootstrap' } }] } }));
  const source = (await api('/sources', 'POST', { name: 'Rocket chain', url: upstreamOrigin + '/rocket-chain' })).data;
  const profile = await profileFor([source]);
  const complete = await api('/generate/preview', 'POST', { profileId: profile.id, customType: 'shadowrocket' });
  assert.equal(complete.status, 422);
  assert.ok(complete.generation.diagnostics.some((diagnostic: any) => diagnostic.code === 'shadowrocket-node-route-unapplied' && diagnostic.severity === 'error'));
  assert.ok(complete.generation.diagnostics.some((diagnostic: any) => diagnostic.code === 'source-doh-bootstrap-missing' && diagnostic.severity === 'warning'));
  assert.equal((await fetch(`${origin}/s/${profile.token}/shadowrocket`)).status, 422);
  const pure = await api('/generate/preview', 'POST', { profileId: profile.id, customType: 'shadowrocket', format: 'b64' });
  assert.equal(pure.success, true, pure.message);
  assert.equal(decoded(pure.data), 'trojan://secret@chained.node.example:443#Chained');
  assert.equal(pure.generation.dependencyNodeCount, 0);
  assert.equal(pure.generation.bindings[0].status, 'ignored');
  assert.deepEqual(pure.generation.diagnostics.map((diagnostic: any) => [diagnostic.code, diagnostic.severity]), [['nodes-only-chain-unapplied', 'warning']]);
  const provider = await fetch(`${origin}/s/${profile.token}/source/${source.id}?target=shadowrocket`);
  assert.equal(provider.status, 200); assert.equal(await provider.text(), pure.data);
  assert.equal(provider.headers.get('X-SubOne-DoH'), 'ignored');
  assert.match(provider.headers.get('X-SubOne-Diagnostics') || '', /nodes-only-chain-unapplied/);
});

test('retained Shadowrocket template dependencies remain outside ordinary candidates and every pure source endpoint', async () => {
  sourceHeaders.set('/rocket-ordinary', 'upload=10; download=20; total=100; expire=4000000000');
  sourceHeaders.set('/rocket-dependency', 'upload=1000; download=2000; total=9000; expire=3000000000');
  const ordinary = await addSource('/rocket-ordinary', [], 'ordinary.runtime.example');
  const dependency = await addSource('/rocket-dependency', ['https://dns.unused.example/dns-query'], 'dependency.runtime.example');
  const required = (await api('/groups', 'POST', { name: 'Required Rocket', type: 'select', proxies: [`node:${dependency.nodes[0].id}`] })).data;
  const content = template.replace('[Proxy Group]\n', '[Proxy Group]\nNative runtime = select, Required Rocket\n').replace('DOMAIN,kept.example,DIRECT', 'DOMAIN,kept.example,Native runtime');
  const profile = await profileFor([ordinary], content);
  const preview = await api('/generate/preview', 'POST', { profileId: profile.id, customType: 'shadowrocket' });
  assert.equal(preview.success, true, preview.message);
  assert.equal(preview.generation.nodeCount, 1); assert.equal(preview.generation.dependencyNodeCount, 1);
  assert.equal(preview.generation.dependencyNodes[0].id, dependency.nodes[0].id);
  const actual = await fetch(`${origin}/s/${profile.token}/rocket`);
  assert.equal(actual.headers.get('subscription-userinfo'), 'upload=10; download=20; total=100; expire=4000000000');
  assert.equal(await actual.text(), preview.data);
  const candidate = preview.data.split('\n').find((line: string) => line.startsWith('Candidates-'))!;
  const dependencyName = preview.data.split('\n').find((line: string) => line.includes(' = trojan, dependency.runtime.example'))!.split(' = ')[0];
  assert.equal(candidate.split(',').map((part: string) => part.trim()).includes(dependencyName), false);
  assert.ok(preview.data.includes(`Required Rocket = select, ${dependencyName}`));
  const pure = await api('/generate/preview', 'POST', { profileId: profile.id, customType: 'shadowrocket', format: 'base64' });
  assert.equal(pure.generation.dependencyNodeCount, 0); assert.doesNotMatch(decoded(pure.data), /dependency.runtime|dns.unused/);
  assert.equal(await fetch(`${origin}/s/${profile.token}/source/${dependency.id}/rocket`).then(response => response.text()), '');
  assert.equal(await fetch(`${origin}/s/${profile.token}/source/${ordinary.id}/rocket`).then(response => response.text()), pure.data);
  await api(`/nodes/${dependency.nodes[0].id}`, 'PUT', { enabled: false });
  const invalid = await api('/generate/preview', 'POST', { profileId: profile.id, customType: 'shadowrocket' });
  assert.equal(invalid.status, 422);
  assert.ok(invalid.generation.diagnostics.some((diagnostic: any) => diagnostic.code === 'shadowrocket-outbound-reference-missing'));
  assert.equal(await fetch(`${origin}/s/${profile.token}/source/${ordinary.id}/rocket`).then(response => response.text()), pure.data);
  assert.equal((await api('/groups')).data.find((group: any) => group.id === required.id).name, 'Required Rocket');
});

test('native Shadowrocket mounted and filtered groups cannot bypass the ordinary profile selection', async () => {
  const ordinary = await addSource('/rocket-filter-ordinary', [], 'filter.ordinary.example');
  const excluded = await addSource('/rocket-filter-excluded', [], 'filter.excluded.example');
  const required = (await api('/groups', 'POST', { name: 'Excluded mounted Rocket', type: 'select', sources: [excluded.id] })).data;
  const content = template.replace('[Proxy Group]\n', '[Proxy Group]\nNative filter = select, Excluded mounted Rocket\n').replace('DOMAIN,kept.example,DIRECT', 'FINAL,Native filter');
  const profile = await profileFor([ordinary], content);
  const invalid = await api('/generate/preview', 'POST', { profileId: profile.id, customType: 'shadowrocket' });
  assert.equal(invalid.status, 422);
  assert.equal(invalid.generation.nodeCount, 1); assert.equal(invalid.generation.dependencyNodeCount, 0);
  assert.ok(invalid.generation.diagnostics.some((diagnostic: any) => diagnostic.code === 'shadowrocket-outbound-reference-missing'));
  assert.equal((await fetch(`${origin}/s/${profile.token}/shadowrocket`)).status, 422);
  const pure = await fetch(`${origin}/s/${profile.token}/source/${ordinary.id}/rocket`);
  assert.equal(pure.status, 200); assert.match(decoded(await pure.text()), /filter.ordinary.example/);
  assert.equal(await fetch(`${origin}/s/${profile.token}/source/${excluded.id}/rocket`).then(response => response.text()), '');
  const saved = (await api('/groups')).data.find((group: any) => group.id === required.id);
  assert.deepEqual(saved.sources, [excluded.id]);
});

test('pure duplicate names, disables and source deletion follow one ordinary selection through reload', async () => {
  const a = await addSource('/rocket-duplicate-a', [], 'duplicate.a.example');
  const b = await addSource('/rocket-duplicate-b', [], 'duplicate.b.example');
  for (const source of [a, b]) await api(`/nodes/${source.nodes[0].id}`, 'PUT', { name: 'Twin, A=B' });
  const profile = await profileFor([a, b], template.replace('[Proxy]\n', '[Proxy]\nTwin, A=B = native, retained.example, 1\n'));
  const pure = await api('/generate/preview', 'POST', { profileId: profile.id, customType: 'shadowrocket', format: 'b64' });
  assert.equal(pure.success, true, pure.message);
  const lines = decoded(pure.data).split('\n');
  assert.deepEqual(lines.map(line => decodeURIComponent(line.split('#')[1])).sort(), ['Twin, A=B', 'Twin, A=B (2)']);
  for (const source of [a, b]) {
    const provider = await fetch(`${origin}/s/${profile.token}/source/${source.id}/rocket`);
    assert.equal(provider.headers.get('X-SubOne-Mode'), 'nodes');
    assert.equal(provider.headers.get('X-SubOne-DoH'), 'ignored');
    const body = decoded(await provider.text()); assert.ok(lines.includes(body)); assert.equal(body.split('\n').length, 1);
  }
  await stopApp(); await startApp();
  assert.equal(await fetch(`${origin}/s/${profile.token}/rocket?format=base64`).then(response => response.text()), pure.data);
  await api(`/nodes/${a.nodes[0].id}`, 'PUT', { enabled: false });
  assert.equal(await fetch(`${origin}/s/${profile.token}/source/${a.id}/rocket`).then(response => response.text()), '');
  const remaining = await fetch(`${origin}/s/${profile.token}/rocket?format=b64`).then(response => response.text());
  assert.equal(decoded(remaining), 'trojan://secret@duplicate.b.example:1080#Twin%2C%20A%3DB');
  await api(`/sources/${b.id}`, 'PUT', { enabled: false });
  assert.equal(await fetch(`${origin}/s/${profile.token}/rocket?format=b64`).then(response => response.text()), '');
  assert.equal((await fetch(`${origin}/s/${profile.token}/source/${b.id}/rocket`)).status, 404);
  await api(`/sources/${b.id}`, 'PUT', { enabled: true });
  assert.equal(await fetch(`${origin}/s/${profile.token}/rocket?format=b64`).then(response => response.text()), remaining);
  await api(`/sources/${b.id}`, 'DELETE');
  await stopApp(); await startApp();
  assert.equal(await fetch(`${origin}/s/${profile.token}/rocket?format=b64`).then(response => response.text()), '');
  assert.equal((await fetch(`${origin}/s/${profile.token}/source/${b.id}/rocket`)).status, 404);
});

test('failed Shadowrocket source updates retain prior intent and successful DoH removal restores template DNS', async () => {
  const source = await addSource('/rocket-removal', ['https://192.0.2.30/one', 'https://192.0.2.31/two'], 'removal.node.example');
  await api(`/nodes/${source.nodes[0].id}`, 'PUT', { name: 'Saved local name' });
  const profile = await profileFor([source]);
  const before = await api('/generate/preview', 'POST', { profileId: profile.id, customType: 'shadowrocket' });
  const pureBefore = await api('/generate/preview', 'POST', { profileId: profile.id, customType: 'shadowrocket', format: 'base64' });
  bodies.set('/rocket-removal', 'proxies: [');
  assert.equal((await api(`/sources/${source.id}/refresh`, 'POST', {})).success, false);
  assert.equal((await api('/generate/preview', 'POST', { profileId: profile.id, customType: 'shadowrocket' })).data, before.data);
  assert.deepEqual((await api('/sources')).data.find((entry: any) => entry.id === source.id).doh, source.doh);
  bodies.set('/rocket-removal', yaml.dump({ proxies: [{ name: 'Upstream renamed', type: 'trojan', server: 'removal.node.example', port: 1080, password: 'secret' }] }));
  assert.equal((await api(`/sources/${source.id}/refresh`, 'POST', {})).success, true);
  const removed = await api('/generate/preview', 'POST', { profileId: profile.id, customType: 'shadowrocket' });
  assert.equal(removed.success, true, removed.message);
  assert.equal(removed.generation.bindings[0].status, 'template');
  assert.equal(removed.generation.bindings[0].method, 'template-dns');
  assert.deepEqual(removed.generation.bindings[0].services, []); assert.deepEqual(removed.generation.diagnostics, []);
  assert.ok(removed.data.includes(template.split('[Proxy]')[0]));
  assert.match(removed.data, /^Saved local name = trojan,/m);
  const pure = await api('/generate/preview', 'POST', { profileId: profile.id, customType: 'shadowrocket', format: 'b64' });
  assert.equal(pure.data, pureBefore.data);
  await stopApp(); await startApp();
  assert.equal(await fetch(`${origin}/s/${profile.token}/rocket`).then(response => response.text()), removed.data);
  assert.equal(await fetch(`${origin}/s/${profile.token}/source/${source.id}/rocket`).then(response => response.text()), pure.data);
});

test('URI protocol omissions are explicit while supported nodes remain available', async () => {
  bodies.set('/rocket-protocols', yaml.dump({ proxies: [
    { name: 'Kept', type: 'trojan', server: 'uri.kept.example', port: 443, password: 'secret' },
    { name: 'SOCKS omitted', type: 'socks5', server: 'uri.socks.example', port: 1080 },
  ] }));
  const source = (await api('/sources', 'POST', { name: 'URI protocols', url: upstreamOrigin + '/rocket-protocols' })).data;
  const profile = await profileFor([source]);
  const pure = await api('/generate/preview', 'POST', { profileId: profile.id, customType: 'shadowrocket', format: 'base64' });
  assert.equal(pure.success, true, pure.message);
  assert.equal(decoded(pure.data), 'trojan://secret@uri.kept.example:443#Kept');
  assert.deepEqual(pure.generation.diagnostics.map((diagnostic: any) => diagnostic.code), ['nodes-only-protocol-unsupported']);
  const provider = await fetch(`${origin}/s/${profile.token}/source/${source.id}/singbox`);
  assert.equal(await provider.text(), pure.data);
  assert.equal(provider.headers.get('X-SubOne-Diagnostics'), 'nodes-only-protocol-unsupported');
  const full = await api('/generate/preview', 'POST', { profileId: profile.id, customType: 'shadowrocket' });
  assert.equal(full.success, true, full.message); assert.match(full.data, /^SOCKS omitted = socks5, uri.socks.example,/m);
});

test('empty Shadowrocket native filter and includeAll groups retain repair intent instead of direct fallback', async () => {
  const source = await addSource('/rocket-empty-filter', [], 'filter.allowed.example');
  const filtered = (await api('/groups', 'POST', { name: 'No matching Rocket', type: 'urltest', filter: '^NeverMatch$', interval: 45 })).data;
  const content = template.replace('DOMAIN,kept.example,DIRECT', 'FINAL,No matching Rocket');
  const profile = await profileFor([source], content, { selectedGroupIds: [filtered.id] });
  const result = await api('/generate/preview', 'POST', { profileId: profile.id, customType: 'shadowrocket' });
  assert.equal(result.status, 422);
  assert.equal(result.generation.dependencyNodeCount, 0);
  assert.ok(result.generation.diagnostics.some((diagnostic: any) => diagnostic.code === 'shadowrocket-outbound-reference-missing'));
  const includeAll = (await api('/groups', 'POST', { name: 'Empty All Rocket', type: 'select', includeAll: true })).data;
  const empty = await profileFor([source], template.replace('DOMAIN,kept.example,DIRECT', 'FINAL,Empty All Rocket'), { selectedGroupIds: [includeAll.id], nodeFilter: { mode: 'manual', selectedNodeIds: [] } });
  const all = await api('/generate/preview', 'POST', { profileId: empty.id, customType: 'shadowrocket' });
  assert.equal(all.status, 422); assert.equal(all.generation.nodeCount, 0); assert.equal(all.generation.dependencyNodeCount, 0);
  assert.equal(await fetch(`${origin}/s/${empty.token}/source/${source.id}/rocket`).then(response => response.text()), '');
});

test('Shadowrocket validates every carried native group branch and managed FINAL overrides unused native policy dependencies', async () => {
  const source = await addSource('/rocket-native-cycle', [], 'cycle.node.example');
  const managed = (await api('/groups', 'POST', { name: 'Managed cycle Rocket', type: 'select', proxies: ['Native cycle Rocket'] })).data;
  const cyclicContent = template.replace('[Proxy Group]\n', '[Proxy Group]\nNative cycle Rocket = select, DIRECT, Managed cycle Rocket\n');
  const cyclic = await profileFor([source], cyclicContent, { selectedGroupIds: [managed.id] });
  const repaired = await api(`/groups/${managed.id}`, 'PUT', { proxies: ['Native cycle Rocket'] });
  assert.deepEqual(repaired.data.proxies, ['template:Native cycle Rocket']);
  const broken = await api('/generate/preview', 'POST', { profileId: cyclic.id, customType: 'shadowrocket' });
  assert.equal(broken.status, 422);
  assert.ok(broken.generation.diagnostics.some((diagnostic: any) => diagnostic.code === 'source-doh-cycle'));
  const pure = await api('/generate/preview', 'POST', { profileId: cyclic.id, customType: 'shadowrocket', format: 'base64' });
  assert.equal(pure.success, true, pure.message); assert.deepEqual(pure.generation.diagnostics, []);
  const unused = await addSource('/rocket-final-unused', ['https://broken.unused.example/dns-query'], 'final.unused.example');
  await api(`/nodes/${unused.nodes[0].id}`, 'PUT', { name: 'Unused FINAL Rocket' });
  const final = (await api('/rules/unified', 'POST', { name: 'Rocket explicit FINAL', kind: 'local', type: 'FINAL', payload: '', outbound: 'DIRECT', enabled: true })).data;
  const lowerContent = template.replace('[Proxy]', '[proxy]').replace('[Proxy Group]', '[proxy group]').replace('[Rule]', '[rule]').replace('DOMAIN,kept.example,DIRECT', 'DOMAIN,kept.example,DIRECT\nfinal,Unused FINAL Rocket');
  const profile = await profileFor([source], lowerContent, { selectedRuleIds: [final.id] });
  const result = await api('/generate/preview', 'POST', { profileId: profile.id, customType: 'shadowrocket' });
  assert.equal(result.success, true, result.message); assert.equal(result.generation.dependencyNodeCount, 0);
  assert.match(result.data, /^FINAL,DIRECT$/m); assert.equal((result.data.match(/^final,/gim) || []).length, 1);
  assert.equal((result.data.match(/^\[proxy\]$/gim) || []).length, 1);
  assert.doesNotMatch(result.data, /final.unused.example|Unused FINAL Rocket/);
});

test('ordinary Shadowrocket strategies retain ordered members, probes, local and remote rules', async () => {
  bodies.set('/rocket-strategies', yaml.dump({ proxies: [
    { name: 'Strategy A', type: 'trojan', server: 'strategy.a.example', port: 443, password: 'a' },
    { name: 'Strategy B', type: 'trojan', server: 'strategy.b.example', port: 443, password: 'b' },
  ] }));
  const source = (await api('/sources', 'POST', { name: 'Rocket strategies', url: upstreamOrigin + '/rocket-strategies' })).data;
  const groups: any[] = [];
  for (const [name, type] of [['Select Rocket', 'select'], ['Probe Rocket', 'urltest'], ['Fallback Rocket', 'fallback'], ['Relay Rocket', 'relay']]) {
    groups.push((await api('/groups', 'POST', { name, type, proxies: [`node:${source.nodes[1].id}`, `node:${source.nodes[0].id}`], url: 'https://probe.rocket.example/check', interval: 71, tolerance: 17 })).data);
  }
  const rules: any[] = [];
  for (const rule of [
    { name: 'Rocket domains', kind: 'local', type: 'DOMAIN-SUFFIX', payload: 'first.example;second.example', outbound: 'Select Rocket' },
    { name: 'Rocket CIDR', kind: 'local', type: 'IP-CIDR', payload: '192.0.2.0/24', outbound: 'DIRECT' },
    { name: 'Rocket remote', kind: 'remote', type: 'RULE-SET', url: 'https://unused.example/rules', clientUrls: { shadowrocket: 'https://native.rocket.example/rules.list' }, outbound: 'Fallback Rocket' },
    { name: 'Rocket final', kind: 'local', type: 'FINAL', payload: '', outbound: 'Relay Rocket' },
  ]) {
    const added = (await api('/rules/unified', 'POST', { ...rule, enabled: true })).data;
    if ('clientUrls' in rule) await api(`/rules/unified/${added.id}`, 'PUT', { clientUrls: rule.clientUrls });
    rules.push(added);
  }
  const profile = await profileFor([source], template, { selectedGroupIds: groups.map(group => group.id), selectedRuleIds: rules.map(rule => rule.id) });
  const result = await api('/generate/preview', 'POST', { profileId: profile.id, customType: 'shadowrocket' });
  assert.equal(result.success, true, result.message);
  assert.match(result.data, /^Select Rocket = select, Strategy B, Strategy A$/m);
  assert.match(result.data, /^Relay Rocket = relay, Strategy B, Strategy A$/m);
  assert.match(result.data, /^Probe Rocket = url-test, Strategy B, Strategy A, url=https:\/\/probe.rocket.example\/check, interval=71, tolerance=17$/m);
  assert.match(result.data, /^Fallback Rocket = fallback, Strategy B, Strategy A, url=https:\/\/probe.rocket.example\/check, interval=71$/m);
  assert.ok(result.data.indexOf('DOMAIN-SUFFIX,first.example,Select Rocket') < result.data.indexOf('DOMAIN-SUFFIX,second.example,Select Rocket'));
  assert.match(result.data, /^IP-CIDR,192.0.2.0\/24,DIRECT,no-resolve$/m);
  assert.match(result.data, /^RULE-SET,https:\/\/native.rocket.example\/rules.list,Fallback Rocket$/m);
  assert.match(result.data, /^FINAL,Relay Rocket$/m);
  assert.equal((result.data.match(/^FINAL,/gm) || []).length, 1);
  const provider = await fetch(`${origin}/s/${profile.token}/source/${source.id}/rocket`);
  assert.deepEqual(decoded(await provider.text()).split('\n'), ['trojan://a@strategy.a.example:443#Strategy%20A', 'trojan://b@strategy.b.example:443#Strategy%20B']);
});

test('Shadowrocket load balancing preserves members, probes and explicit strategy and lazy options through reload', async () => {
  bodies.set('/rocket-load-balance', yaml.dump({ proxies: [
    { name: 'Balance A', type: 'trojan', server: 'balance.a.example', port: 443, password: 'a' },
    { name: 'Balance B', type: 'trojan', server: 'balance.b.example', port: 443, password: 'b' },
  ] }));
  const addedSource = await api('/sources', 'POST', { name: 'Rocket load balance', url: upstreamOrigin + '/rocket-load-balance' });
  assert.equal(addedSource.success, true, addedSource.message);
  const source = addedSource.data;
  const cases = [
    { name: 'AUTO_HK', strategy: 'consistent-hashing', lazy: true },
    { name: 'Round Robin Rocket', strategy: 'round-robin', lazy: false },
    { name: 'Sticky Rocket', strategy: 'sticky-sessions' },
    { name: 'Default Balance Rocket' },
  ];
  const groups: any[] = [];
  for (const options of cases) {
    const added = await api('/groups', 'POST', { ...options, type: 'load-balance',
      proxies: [`node:${source.nodes[1].id}`, `node:${source.nodes[0].id}`],
      url: 'https://probe.balance.example/check', interval: 71 });
    assert.equal(added.success, true, added.message);
    groups.push(added.data);
  }
  const defaults = await api('/groups', 'POST', { name: 'Default Probe Rocket', type: 'load-balance', sources: [source.id] });
  assert.equal(defaults.success, true, defaults.message);
  groups.push(defaults.data);
  const profile = await profileFor([source], template, { selectedGroupIds: groups.map(group => group.id) });
  const complete = await api('/generate/preview', 'POST', { profileId: profile.id, customType: 'shadowrocket' });
  assert.equal(complete.status, 200, complete.message);
  assert.deepEqual(complete.generation.diagnostics, []);
  const lines = complete.data.split('\n');
  assert.ok(lines.includes('AUTO_HK = load-balance, Balance B, Balance A, url=https://probe.balance.example/check, interval=71, strategy=consistent-hashing, lazy=true'));
  assert.ok(lines.includes('Round Robin Rocket = load-balance, Balance B, Balance A, url=https://probe.balance.example/check, interval=71, strategy=round-robin, lazy=false'));
  assert.ok(lines.includes('Sticky Rocket = load-balance, Balance B, Balance A, url=https://probe.balance.example/check, interval=71, strategy=sticky-sessions'));
  assert.ok(lines.includes('Default Balance Rocket = load-balance, Balance B, Balance A, url=https://probe.balance.example/check, interval=71'));
  assert.ok(lines.includes('Default Probe Rocket = load-balance, Balance A, Balance B, url=http://cp.cloudflare.com/generate_204, interval=300'));
  const download = await fetch(`${origin}/s/${profile.token}/shadowrocket`);
  assert.equal(download.status, 200); assert.equal(await download.text(), complete.data);
  await stopApp(); await startApp();
  assert.equal(await fetch(`${origin}/s/${profile.token}/rocket`).then(response => response.text()), complete.data);
  const pure = await api('/generate/preview', 'POST', { profileId: profile.id, customType: 'shadowrocket', format: 'b64' });
  assert.equal(pure.success, true, pure.message); assert.deepEqual(pure.generation.diagnostics, []);
  assert.deepEqual(decoded(pure.data).split('\n'), ['trojan://a@balance.a.example:443#Balance%20A', 'trojan://b@balance.b.example:443#Balance%20B']);
});
