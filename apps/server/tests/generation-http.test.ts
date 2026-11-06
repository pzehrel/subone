import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
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

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'subone-generation-http-'));
  await writeFile(join(directory, 'config.json'), JSON.stringify({ port: 3456, adminPassword: '' }));
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const address = upstream.address(); assert.ok(address && typeof address !== 'string');
  upstreamOrigin = `http://127.0.0.1:${address.port}`; await startApp();
});
after(async () => { await stopApp(); await new Promise<void>(resolve => upstream.close(() => resolve())); await rm(directory, { recursive: true, force: true }); });

const template = {
  log: { disabled: true },
  dns: { servers: [
    { type: 'udp', tag: 'bootstrap', server: '127.0.0.1', server_port: 54535 },
    { type: 'tls', tag: 'template-dot', server: '192.0.2.54', server_port: 853 },
  ], rules: [{ domain_suffix: ['template.example'], server: 'template-dot' }], final: 'bootstrap', cache_capacity: 512 },
  route: { default_domain_resolver: { server: 'bootstrap' }, rules: [{ domain: ['kept.example'], outbound: 'template-direct' }] },
  outbounds: [{ type: 'direct', tag: 'template-direct' }],
};
async function addSource(path: string, dns: unknown[], server: string) {
  bodies.set(path, JSON.stringify({ outbounds: [{ type: 'socks', tag: 'Shared', server, server_port: 1080, version: '5' }], dns: { servers: dns } }));
  const response = await api('/sources', 'POST', { name: path.slice(1), url: upstreamOrigin + path });
  assert.equal(response.success, true, response.message);
  return response.data;
}
async function profileFor(sources: any[], content: Record<string, unknown> = template) {
  const group = (await api('/groups', 'POST', { name: `Candidates-${Math.random()}`, type: 'select', sources: sources.map(source => source.id) })).data;
  const rule = (await api('/rules/unified', 'POST', { name: 'Isolated rule', kind: 'local', type: 'DOMAIN', payload: 'isolated.example', outbound: 'template-direct', enabled: true })).data;
  const tpl = (await api('/templates', 'POST', { name: 'Generation template', type: 'singbox', content: JSON.stringify(content) })).data;
  return (await api('/profiles', 'POST', { name: 'Generation profile', nodeFilter: { mode: 'all', sourceIds: sources.map(source => source.id) }, selectedGroupIds: [group.id], selectedRuleIds: [rule.id], templates: { singbox: tpl.id } })).data;
}
test('source bindings reach both preview and actual sing-box output and survive reload without replacing template DNS', async () => {
  const a = await addSource('/direct-a', [{ type: 'https', server: 'dns.a.example', path: '/source-query', headers: { Authorization: 'Bearer source' } }], 'node.a.example');
  const b = await addSource('/direct-b', [{ type: 'https', server: 'dns.b.example', path: '/dns-query' }], 'node.b.example');
  const profile = await profileFor([a, b]);
  const preview = await api('/generate/preview', 'POST', { profileId: profile.id, customType: 'singbox' });
  assert.equal(preview.success, true, preview.message);
  assert.equal(preview.generation.target.version, '1.14.4');
  assert.equal(preview.generation.nodeCount, 2);
  assert.equal(preview.generation.dependencyNodeCount, 0);
  assert.deepEqual(preview.generation.bindings.map((binding: any) => [binding.sourceId, binding.batchId, binding.status]), [[a.id, a.doh.batchId, 'applied'], [b.id, b.doh.batchId, 'applied']]);
  const doc = JSON.parse(preview.data);
  assert.deepEqual(doc.dns.servers.slice(0, 2), template.dns.servers);
  assert.deepEqual(doc.dns.rules, template.dns.rules);
  assert.equal(doc.dns.cache_capacity, 512);
  assert.ok(doc.route.rules.some((rule: any) => rule.domain?.[0] === 'kept.example'));
  for (const [server, dns] of [['node.a.example', 'dns.a.example'], ['node.b.example', 'dns.b.example']]) {
    const outbound = doc.outbounds.find((entry: any) => entry.server === server);
    const resolver = doc.dns.servers.find((entry: any) => entry.tag === outbound.domain_resolver.server);
    assert.equal(resolver.server, dns);
    assert.deepEqual(resolver.domain_resolver, { server: 'bootstrap' });
  }
  const response = await fetch(`${origin}/s/${profile.token}/singbox`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), preview.data);
  await stopApp(); await startApp();
  assert.equal(await fetch(`${origin}/s/${profile.token}/singbox`).then(response => response.text()), preview.data);
});

test('generated direct source DoH configuration is accepted and loaded by sing-box 1.14.4', { skip: !process.env.SUBONE_SINGBOX_BINARY }, async () => {
  const source = await addSource('/runtime', [{ type: 'udp', tag: 'private-runtime-bootstrap', server: '127.0.0.1', server_port: 54535 }, { type: 'https', server: 'dns.runtime.example', domain_resolver: { server: 'private-runtime-bootstrap' }, tls: { server_name: 'tls.runtime.example' }, headers: { Authorization: 'Bearer dummy' } }], 'node.runtime.example');
  const profile = await profileFor([source]);
  const response = await fetch(`${origin}/s/${profile.token}/singbox`);
  assert.equal(response.status, 200);
  const path = join(directory, 'generated-singbox.json');
  const output = await response.text();
  await writeFile(path, output);
  if (process.env.SUBONE_GENERATION_CONFIG) await writeFile(process.env.SUBONE_GENERATION_CONFIG, output);
  const check = spawnSync(process.env.SUBONE_SINGBOX_BINARY!, ['check', '-c', path], { encoding: 'utf8', timeout: 5000 });
  assert.equal(check.status, 0, check.stderr);
  const startup = spawnSync(process.env.SUBONE_SINGBOX_BINARY!, ['run', '-c', path], { encoding: 'utf8', timeout: 1000 });
  assert.ok(startup.error && 'code' in startup.error, startup.stderr);
  assert.equal(startup.error.code, 'ETIMEDOUT', startup.stderr);
  assert.doesNotMatch(startup.stderr, /FATAL/);
});

test('multi-DoH selects the first service per profile, reports degradation and leaves every saved service intact', async () => {
  const source = await addSource('/multi', [{ type: 'https', server: 'first.multi.example' }, { type: 'https', server: 'second.multi.example' }], 'node.multi.example');
  const one = await profileFor([source]);
  const two = await profileFor([source]);
  for (const profile of [one, two]) {
    const preview = await api('/generate/preview', 'POST', { profileId: profile.id, customType: 'singbox' });
    const binding = preview.generation.bindings[0];
    assert.equal(binding.status, 'degraded');
    assert.deepEqual(binding.appliedServiceIds, [source.doh.services[0].id]);
    assert.deepEqual(binding.services.map((entry: any) => entry.url), ['https://first.multi.example/dns-query', 'https://second.multi.example/dns-query']);
    assert.equal(binding.diagnostics[0].code, 'source-doh-first-only');
    const doc = JSON.parse(preview.data);
    assert.equal(doc.dns.servers.some((entry: any) => entry.server === 'second.multi.example'), false);
    assert.equal(await fetch(`${origin}/s/${profile.token}/singbox`).then(response => response.text()), preview.data);
  }
  assert.deepEqual((await api('/sources')).data.find((entry: any) => entry.id === source.id).doh, source.doh);
});

test('removing source DoH restores template DNS without leaking raw source resolver references', async () => {
  const source = await addSource('/remove', [{ type: 'https', server: 'removed.example' }], 'node.remove.example');
  const profile = await profileFor([source]);
  bodies.set('/remove', JSON.stringify({ outbounds: [{ type: 'socks', tag: 'Without DoH', server: 'node.remove.example', server_port: 1080, version: '5', domain_resolver: { server: 'upstream-only' } }], dns: { servers: [{ type: 'udp', tag: 'upstream-only', server: '192.0.2.53' }] } }));
  assert.equal((await api(`/sources/${source.id}/refresh`, 'POST', {})).success, true);
  const preview = await api('/generate/preview', 'POST', { profileId: profile.id, customType: 'singbox' });
  assert.equal(preview.success, true, preview.message);
  const doc = JSON.parse(preview.data);
  assert.deepEqual(doc.dns, template.dns);
  assert.equal(doc.outbounds.find((entry: any) => entry.server === 'node.remove.example').domain_resolver, undefined);
  assert.equal(preview.generation.bindings[0].status, 'template');
  assert.deepEqual(preview.generation.bindings[0].services, []);
  assert.equal(await fetch(`${origin}/s/${profile.token}/singbox`).then(response => response.text()), preview.data);
});

test('source bootstrap tags stay private even when a template resolver uses the same label', async () => {
  const source = await addSource('/source-bootstrap', [{ type: 'udp', tag: 'bootstrap', server: '192.0.2.55' }, { type: 'https', server: 'dns.private.example', domain_resolver: { server: 'bootstrap', strategy: 'ipv4_only' }, tls: { server_name: 'tls.private.example' } }], 'node.private.example');
  const profile = await profileFor([source]);
  const preview = await api('/generate/preview', 'POST', { profileId: profile.id, customType: 'singbox' });
  assert.equal(preview.success, true, preview.message);
  const doc = JSON.parse(preview.data);
  const doh = doc.dns.servers.find((entry: any) => entry.server === 'dns.private.example');
  assert.notEqual(doh.domain_resolver.server, 'bootstrap');
  assert.equal(doh.domain_resolver.strategy, 'ipv4_only');
  assert.deepEqual(doh.tls, { server_name: 'tls.private.example' });
  assert.equal(doc.dns.servers.find((entry: any) => entry.tag === doh.domain_resolver.server).server, '192.0.2.55');
  assert.deepEqual(doc.dns.servers.find((entry: any) => entry.tag === 'bootstrap'), template.dns.servers[0]);
  assert.equal(preview.generation.dependencyNodeCount, 0);
  assert.equal(await fetch(`${origin}/s/${profile.token}/singbox`).then(response => response.text()), preview.data);
});

test('missing independent bootstrap rejects adopted binding in both HTTP paths without a guessed resolver', async () => {
  const missingTemplate = { ...template, route: { ...template.route, default_domain_resolver: undefined } };
  const source = await addSource('/missing-template-bootstrap', [{ type: 'https', server: 'dns.needs-bootstrap.example' }], 'node.needs-bootstrap.example');
  const profile = await profileFor([source], missingTemplate);
  const preview = await api('/generate/preview', 'POST', { profileId: profile.id, customType: 'singbox' });
  assert.equal(preview.status, 422);
  assert.equal(preview.success, false);
  assert.equal(preview.generation.bindings[0].status, 'unapplied');
  assert.equal(preview.generation.diagnostics[0].code, 'source-doh-bootstrap-missing');
  assert.equal(preview.generation.diagnostics[0].severity, 'error');
  assert.equal(preview.generation.diagnostics[0].sourceId, source.id);
  const actual = await fetch(`${origin}/s/${profile.token}/singbox`);
  assert.equal(actual.status, 422);
  assert.deepEqual((await actual.json() as any).generation, preview.generation);
  const explicitMissing = await addSource('/missing-source-bootstrap', [{ type: 'https', server: 'dns.explicit.example', domain_resolver: { server: 'bootstrap' } }], 'node.explicit.example');
  const explicitProfile = await profileFor([explicitMissing]);
  const explicitPreview = await api('/generate/preview', 'POST', { profileId: explicitProfile.id, customType: 'singbox' });
  assert.equal(explicitPreview.status, 422, 'a same-named template resolver must not repair a missing source tag');
  assert.equal(explicitPreview.generation.diagnostics[0].code, 'source-doh-bootstrap-missing');
});

test('all six complete outputs share preview and dispatch while unsupported adapters report every source binding', async () => {
  const a = await addSource('/adapters-a', [{ type: 'https', server: 'dns.adapters-a.example' }], 'node.adapters-a.example');
  const b = await addSource('/adapters-b', [{ type: 'https', server: 'dns.adapters-b.example' }], 'node.adapters-b.example');
  const profile = await profileFor([a, b]);
  for (const target of ['singbox', 'mihomo', 'loon', 'quantumultx', 'egern', 'shadowrocket']) {
    const preview = await api('/generate/preview', 'POST', { profileId: profile.id, customType: target, expandNodes: true });
    assert.equal(preview.success, true, `${target}: ${preview.message}`);
    const actual = await fetch(`${origin}/s/${profile.token}/${target}?expand=true`);
    assert.equal(actual.status, 200, target);
    assert.equal(await actual.text(), preview.data, target);
    assert.equal(preview.generation.bindings.length, 2);
    if (target !== 'singbox') {
      assert.deepEqual(preview.generation.bindings.map((binding: any) => binding.status), ['unapplied', 'unapplied']);
      assert.deepEqual(preview.generation.diagnostics.map((entry: any) => entry.sourceId), [a.id, b.id]);
      assert.ok(preview.generation.diagnostics.every((entry: any) => entry.code === 'source-doh-unsupported'));
    }
  }
});

test('pure Base64 output ignores DoH and DNS-only dependencies while retaining profile node selection', async () => {
  bodies.set('/pure', JSON.stringify({ outbounds: [
    { type: 'shadowsocks', tag: 'Ordinary', server: 'ordinary.pure.example', server_port: 1080, method: 'aes-128-gcm', password: 'dummy' },
    { type: 'shadowsocks', tag: 'DNS-only exit', server: 'dns-only.pure.example', server_port: 1081, method: 'aes-128-gcm', password: 'dummy' },
  ], dns: { servers: [{ type: 'https', server: 'resolver.pure.example', detour: 'DNS-only exit' }] } }));
  const source = (await api('/sources', 'POST', { name: 'Pure source', url: upstreamOrigin + '/pure' })).data;
  const profile = await profileFor([source]);
  await api(`/profiles/${profile.id}`, 'PUT', { nodeFilter: { mode: 'manual', selectedNodeIds: [source.nodes[0].id] } });
  const complete = await api('/generate/preview', 'POST', { profileId: profile.id, customType: 'singbox' });
  assert.equal(complete.status, 422);
  assert.ok(complete.generation.diagnostics.some((entry: any) => entry.severity === 'error'));
  const preview = await api('/generate/preview', 'POST', { profileId: profile.id, customType: 'shadowrocket', format: 'base64' });
  assert.equal(preview.success, true, preview.message);
  assert.equal(preview.generation.target.mode, 'nodes');
  assert.equal(preview.generation.bindings[0].status, 'ignored');
  assert.equal(preview.generation.dependencyNodeCount, 0);
  const decoded = Buffer.from(preview.data, 'base64').toString();
  assert.match(decoded, /ordinary.pure.example/);
  assert.doesNotMatch(decoded, /dns-only.pure.example|resolver.pure.example/);
  assert.equal(await fetch(`${origin}/s/${profile.token}/shadowrocket?format=b64`).then(response => response.text()), preview.data);
});

test('source route default bootstrap is adopted in its source namespace before the template default', async () => {
  bodies.set('/source-default-bootstrap', JSON.stringify({
    outbounds: [{ type: 'socks', tag: 'Node', server: 'node.default.example', server_port: 1080 }],
    dns: { servers: [
      { type: 'udp', tag: 'bootstrap', server: '192.0.2.56', domain_resolver: { server: 'root' } },
      { type: 'udp', tag: 'root', server: '192.0.2.57' },
      { type: 'https', server: 'dns.default.example' },
    ] }, route: { default_domain_resolver: { server: 'bootstrap', strategy: 'ipv4_only' } },
  }));
  const source = (await api('/sources', 'POST', { name: 'Source default bootstrap', url: upstreamOrigin + '/source-default-bootstrap' })).data;
  const profile = await profileFor([source]);
  const preview = await api('/generate/preview', 'POST', { profileId: profile.id, customType: 'singbox' });
  assert.equal(preview.success, true, preview.message);
  const doc = JSON.parse(preview.data);
  const doh = doc.dns.servers.find((entry: any) => entry.server === 'dns.default.example');
  const bootstrap = doc.dns.servers.find((entry: any) => entry.tag === doh.domain_resolver.server);
  assert.equal(bootstrap.server, '192.0.2.56');
  assert.equal(doh.domain_resolver.strategy, 'ipv4_only');
  assert.equal(bootstrap.domain_resolver, undefined, 'IP bootstrap never performs an unused hostname lookup');
  assert.equal(doc.dns.servers.some((entry: any) => entry.server === '192.0.2.57'), false);
});

test('cross-format direct DoH retains URL path and query but does not silently discard credentials or flags', async () => {
  const saved: any[] = [];
  for (const [name, url] of [['url-direct', 'https://dns.url.example:8443/custom?token=kept#DIRECT'], ['url-credentials', 'https://user:secret@dns.auth.example/query#DIRECT'], ['url-flags', 'https://dns.flags.example/query#DIRECT&h3=true']]) {
    bodies.set(`/${name}`, `proxies:\n - {name: ${name}, type: ss, server: ${name}.example, port: 443, cipher: aes-128-gcm, password: dummy}\ndns:\n nameserver: ['${url}']\n`);
    const response = await api('/sources', 'POST', { name, url: upstreamOrigin + '/' + name });
    assert.equal(response.success, true, response.message); saved.push(response.data);
  }
  const profile = await profileFor(saved);
  const preview = await api('/generate/preview', 'POST', { profileId: profile.id, customType: 'singbox' });
  assert.equal(preview.success, true, preview.message);
  assert.deepEqual(preview.generation.bindings.map((binding: any) => binding.status), ['applied', 'unapplied', 'unapplied']);
  const doc = JSON.parse(preview.data);
  const adopted = doc.dns.servers.find((entry: any) => entry.server === 'dns.url.example');
  assert.equal(adopted.path, '/custom?token=kept');
  assert.equal(adopted.server_port, 8443);
  assert.equal(doc.dns.servers.some((entry: any) => entry.server === 'dns.auth.example' || entry.server === 'dns.flags.example'), false);
  assert.ok(preview.generation.bindings.slice(1).every((binding: any) => binding.diagnostics[0].code === 'source-doh-options-unapplied'));
});

test('relay copies keep their source binding and remove foreign source resolver tags when DoH is removed', async () => {
  const upstreamDocument = { outbounds: [
    { type: 'socks', tag: 'Relay entry', server: '192.0.2.80', server_port: 1080, domain_resolver: { server: 'source-only' } },
    { type: 'socks', tag: 'Relay exit', server: 'relay.exit.example', server_port: 1081, domain_resolver: { server: 'source-only' } },
  ], dns: { servers: [{ type: 'https', server: '192.0.2.53' }, { type: 'udp', tag: 'source-only', server: '192.0.2.54' }] } };
  bodies.set('/relay-binding', JSON.stringify(upstreamDocument));
  const source = (await api('/sources', 'POST', { name: 'Relay binding', url: upstreamOrigin + '/relay-binding' })).data;
  const relay = (await api('/groups', 'POST', { name: 'Bound relay', type: 'relay', proxies: source.nodes.map((node: any) => `node:${node.id}`) })).data;
  const profile = await profileFor([source]);
  await api(`/profiles/${profile.id}`, 'PUT', { selectedGroupIds: [relay.id] });
  const preview = await api('/generate/preview', 'POST', { profileId: profile.id, customType: 'singbox' });
  assert.equal(preview.success, true, preview.message);
  const doc = JSON.parse(preview.data);
  const direct = doc.outbounds.find((entry: any) => entry.tag === 'Relay exit');
  const clone = doc.outbounds.find((entry: any) => entry.tag === 'Bound relay');
  assert.deepEqual(clone.domain_resolver, direct.domain_resolver);
  assert.notEqual(clone.domain_resolver.server, 'source-only');
  assert.equal(clone._sourceId, undefined);
  assert.equal(clone._sourceName, undefined);
  if (process.env.SUBONE_SINGBOX_BINARY) {
    const path = join(directory, 'generated-relay.json');
    await writeFile(path, preview.data);
    const check = spawnSync(process.env.SUBONE_SINGBOX_BINARY, ['check', '-c', path], { encoding: 'utf8', timeout: 5000 });
    assert.equal(check.status, 0, check.stderr);
  }
  bodies.set('/relay-binding', JSON.stringify({ ...upstreamDocument, dns: { servers: [{ type: 'udp', tag: 'source-only', server: '192.0.2.54' }] } }));
  assert.equal((await api(`/sources/${source.id}/refresh`, 'POST', {})).success, true);
  const fallback = await api('/generate/preview', 'POST', { profileId: profile.id, customType: 'singbox' });
  assert.equal(fallback.success, true, fallback.message);
  assert.equal(JSON.parse(fallback.data).outbounds.find((entry: any) => entry.tag === 'Bound relay').domain_resolver, undefined);
});
