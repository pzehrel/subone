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
const upstream = createServer((request, response) => response.end(bodies.get(request.url || '/') || 'proxies: []'));
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
  directory = await mkdtemp(join(tmpdir(), 'subone-loon-http-'));
  await writeFile(join(directory, 'config.json'), JSON.stringify({ port: 3456, adminPassword: '' }));
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const address = upstream.address(); assert.ok(address && typeof address !== 'string'); upstreamOrigin = `http://127.0.0.1:${address.port}`; await startApp();
});
after(async () => { await stopApp(); await new Promise<void>(resolve => upstream.close(() => resolve())); await rm(directory, { recursive: true, force: true }); });
const template = '[General]\ndns-server = system,192.0.2.53\ndoh-server = https://ordinary.example/dns-query\nallow-wifi-access = false\n\n[Host]\nkept.example = 192.0.2.10\n\n[Proxy]\n\n[Proxy Group]\n\n[Rule]\nDOMAIN,kept.example,DIRECT\n';
async function addSource(path: string, dns: unknown[], server: string) {
  bodies.set(path, yaml.dump({ proxies: [{ name: 'Shared', type: 'socks5', server, port: 1080 }], dns: { nameserver: dns } }));
  const response = await api('/sources', 'POST', { name: path.slice(1), url: upstreamOrigin + path }); assert.equal(response.success, true, response.message); return response.data;
}
async function profileFor(sources: any[], content = template, extra: Record<string, unknown> = {}) {
  const group = (await api('/groups', 'POST', { name: `Candidates-${Math.random()}`, type: 'select', sources: sources.map(source => source.id) })).data;
  const tpl = (await api('/templates', 'POST', { name: 'Loon template', type: 'loon', content })).data;
  const rule = (await api('/rules/unified', 'POST', { name: 'Loon local rule', kind: 'local', type: 'DOMAIN', payload: 'managed-rule.example', outbound: 'DIRECT', enabled: true })).data;
  const response = await api('/profiles', 'POST', { name: 'Loon profile', nodeFilter: { mode: 'all', sourceIds: sources.map(source => source.id) }, selectedGroupIds: [group.id], selectedRuleIds: [rule.id], templates: { loon: tpl.id }, ...extra }); assert.equal(response.success, true, response.message); return response.data;
}
function proxyLines(content: string): string[] { return content.split('\n').filter(line => / = SOCKS5,/.test(line)); }

test('Loon projects separate source node DNS lists in order with native DoH lists across HTTP and reload', async () => {
  const a = await addSource('/loon-a', ['https://192.0.2.1/dns-query', 'https://192.0.2.2/second'], 'node.a.example');
  const b = await addSource('/loon-b', ['https://192.0.2.3/dns-query'], 'node.b.example');
  const profile = await profileFor([a, b]);
  const preview = await api('/generate/preview', 'POST', { profileId: profile.id, customType: 'loon', expandNodes: true });
  assert.equal(preview.success, true, preview.message);
  assert.equal(preview.generation.target.version, '3.5.3');
  if (process.env.SUBONE_LOON_ARTIFACT) await writeFile(process.env.SUBONE_LOON_ARTIFACT, preview.data);
  assert.deepEqual(preview.generation.bindings.map((binding: any) => [binding.status, binding.appliedServiceIds]), [['applied', a.doh.services.map((service: any) => service.id)], ['applied', b.doh.services.map((service: any) => service.id)]]);
  assert.match(proxyLines(preview.data).find(line => line.includes('node.a.example'))!, /server-dns="https:\/\/192\.0\.2\.1\/dns-query,https:\/\/192\.0\.2\.2\/second"$/);
  assert.match(proxyLines(preview.data).find(line => line.includes('node.b.example'))!, /server-dns="https:\/\/192\.0\.2\.3\/dns-query"$/);
  assert.ok(preview.generation.diagnostics.every((diagnostic: any) => diagnostic.code === 'loon-doh-transport-unverified'));
  assert.ok(preview.data.includes(template.split('[Proxy]')[0]));
  assert.match(preview.data, /DOMAIN,kept.example,DIRECT/);
  const actual = await fetch(`${origin}/s/${profile.token}/loon?expand=true`); assert.equal(actual.status, 200); assert.equal(await actual.text(), preview.data);
  await stopApp(); await startApp();
  assert.equal(await fetch(`${origin}/s/${profile.token}/loon?expand=true`).then(response => response.text()), preview.data);
  assert.deepEqual((await api('/sources')).data.find((source: any) => source.id === a.id).doh, a.doh);
});

test('unsupported Loon DoH egress and connection options retain template DNS without collecting unused exits', async () => {
  const sourcePath = '/loon-egress';
  bodies.set(sourcePath, JSON.stringify({ outbounds: [
    { type: 'socks', tag: 'ordinary', server: 'ordinary.egress.example', server_port: 1080, version: '5' },
    { type: 'socks', tag: 'unused exit', server: 'unused.egress.example', server_port: 1081, version: '5' },
  ], dns: { servers: [{ type: 'https', server: '192.0.2.5', detour: 'unused exit' }] } }));
  const source = (await api('/sources', 'POST', { name: 'Loon egress', url: upstreamOrigin + sourcePath })).data;
  const exit = source.nodes.find((node: any) => node.server === 'unused.egress.example');
  assert.equal((await api(`/nodes/${exit.id}`, 'PUT', { enabled: false })).success, true);
  const profile = await profileFor([source]);
  const preview = await api('/generate/preview', 'POST', { profileId: profile.id, customType: 'loon', expandNodes: true });
  assert.equal(preview.success, true, preview.message);
  assert.equal(preview.generation.bindings[0].status, 'unapplied');
  assert.deepEqual(preview.generation.bindings[0].appliedServiceIds, []);
  assert.equal(preview.generation.diagnostics[0].code, 'source-doh-egress-unapplied');
  assert.equal(preview.generation.dependencyNodeCount, 0);
  assert.doesNotMatch(preview.data, /server-dns=|unused.egress.example/);
  assert.ok(preview.data.includes(template.split('[Proxy]')[0]));
  for (const [name, server] of [
    ['bootstrap', { type: 'https', server: 'bootstrap.dns.example', domain_resolver: { server: 'missing-source-resolver' } }],
    ['headers', { type: 'https', server: '192.0.2.8', headers: { Authorization: 'Bearer source' } }],
  ] as const) {
    const path = `/loon-${name}`;
    bodies.set(path, JSON.stringify({ outbounds: [{ type: 'socks', tag: name, server: `node.${name}.example`, server_port: 1080, version: '5' }], dns: { servers: [server] } }));
    const added = (await api('/sources', 'POST', { name, url: upstreamOrigin + path })).data;
    const configured = await profileFor([added]);
    const result = await api('/generate/preview', 'POST', { profileId: configured.id, customType: 'loon', expandNodes: true });
    assert.equal(result.success, true, result.message);
    assert.equal(result.generation.bindings[0].status, 'unapplied');
    assert.equal(result.generation.diagnostics[0].code, name === 'bootstrap' ? 'source-doh-bootstrap-missing' : 'source-doh-options-unapplied');
    assert.doesNotMatch(result.data, /server-dns=/);
    assert.deepEqual((await api('/sources')).data.find((entry: any) => entry.id === added.id).doh, added.doh);
  }
});

test('Loon keeps native template namespaces and stable managed references through rename and reload', async () => {
  const source = await addSource('/loon-template', ['https://192.0.2.11/dns-query'], 'node.template.example');
  const managed = (await api('/groups', 'POST', { name: 'Managed Loon', type: 'urltest', proxies: [`node:${source.nodes[0].id}`], url: 'https://probe.example/check', interval: 73, tolerance: 19 })).data;
  const content = template.replace('[Proxy]\n', '[Proxy]\nShared = SOCKS5,native.template.example,1081\n').replace('[Proxy Group]\n', '[Proxy Group]\nNative = url-test, Managed Loon, Shared, url=https://native-probe.example/check, interval=47, tolerance=13\n').replace('DOMAIN,kept.example,DIRECT', 'DOMAIN,kept.example,Native\nDOMAIN,managed.example,Managed Loon\nFINAL,Native');
  const profile = await profileFor([source], content, { selectedGroupIds: [managed.id] });
  assert.equal((await api(`/groups/${managed.id}`, 'PUT', { ...managed, name: 'Managed Renamed' })).success, true);
  assert.equal((await api(`/nodes/${source.nodes[0].id}`, 'PUT', { name: 'Shared' })).success, true);
  const preview = await api('/generate/preview', 'POST', { profileId: profile.id, customType: 'loon', expandNodes: true });
  assert.equal(preview.success, true, preview.message);
  assert.match(preview.data, /^Shared = SOCKS5,native\.template\.example,1081$/m);
  assert.match(preview.data, /^Shared \(2\) = SOCKS5,node\.template\.example,1080.*server-dns=/m);
  assert.match(preview.data, /^Native = url-test, Managed Renamed, Shared, url=https:\/\/native-probe\.example\/check, interval=47, tolerance=13$/m);
  assert.match(preview.data, /^Managed Renamed = url-test, Shared \(2\), url=https:\/\/probe\.example\/check, interval=73, tolerance=19$/m);
  assert.match(preview.data, /^DOMAIN,managed.example,Managed Renamed$/m);
  assert.match(preview.data, /^FINAL,Native$/m);
  assert.equal((preview.data.match(/^FINAL,/gm) || []).length, 1);
  const saved = (await api('/templates')).data.find((entry: any) => entry.id === profile.templates.loon);
  assert.equal(saved.content, content);
  await stopApp(); await startApp();
  assert.equal(await fetch(`${origin}/s/${profile.token}/loon?expand=true`).then(response => response.text()), preview.data);
});

test('retained Loon template references complete runtime dependencies without adding them to ordinary candidates or providers', async () => {
  const ordinary = await addSource('/loon-ordinary', ['https://192.0.2.20/dns-query'], 'ordinary.runtime.example');
  const dependency = await addSource('/loon-dependency', ['https://192.0.2.21/dns-query'], 'dependency.runtime.example');
  // An explicit stable pin authorizes this connection dependency; an ordinary mount cannot widen the profile pool.
  const requiredGroup = (await api('/groups', 'POST', { name: 'Loon required', type: 'select', proxies: [`node:${dependency.nodes[0].id}`] })).data;
  const content = template.replace('[Proxy Group]\n', '[Proxy Group]\nNative runtime = select, Loon required\n').replace('DOMAIN,kept.example,DIRECT', 'DOMAIN,kept.example,Native runtime');
  const profile = await profileFor([ordinary], content);
  const preview = await api('/generate/preview', 'POST', { profileId: profile.id, customType: 'loon', expandNodes: true });
  assert.equal(preview.success, true, preview.message);
  assert.equal(preview.generation.nodeCount, 1);
  assert.equal(preview.generation.dependencyNodeCount, 1);
  assert.equal(preview.generation.dependencyNodes[0].id, dependency.nodes[0].id);
  const lines = proxyLines(preview.data); assert.equal(lines.length, 2);
  const ordinaryLine = lines.find(line => line.includes('ordinary.runtime.example'))!;
  const dependencyLine = lines.find(line => line.includes('dependency.runtime.example'))!;
  const ordinaryName = ordinaryLine.split(' = ')[0]; const dependencyName = dependencyLine.split(' = ')[0];
  assert.match(preview.data, new RegExp(`^Loon required = select, ${dependencyName.replace(/[()]/g, '\\$&')}$`, 'm'));
  assert.equal(preview.data.split('\n').find((line: string) => line.startsWith('Candidates-'))!.split(',').map((part: string) => part.trim()).includes(dependencyName), false);
  assert.equal(await fetch(`${origin}/s/${profile.token}/source/${ordinary.id}?target=loon`).then(response => response.text()), `[Proxy]\n${ordinaryLine}`);
  assert.equal(await fetch(`${origin}/s/${profile.token}/source/${dependency.id}?target=loon`).then(response => response.text()), '[Proxy]');
  const remote = await fetch(`${origin}/s/${profile.token}/loon?expand=false`).then(response => response.text());
  assert.ok(remote.includes(dependencyLine));
  assert.equal(remote, preview.data);
  assert.doesNotMatch(remote, /\/source\//);
  assert.doesNotMatch(remote, new RegExp(`/source/${dependency.id}`));
  assert.ok(ordinaryName);
  assert.equal((await api(`/nodes/${dependency.nodes[0].id}`, 'PUT', { enabled: false })).success, true);
  const broken = await api('/generate/preview', 'POST', { profileId: profile.id, customType: 'loon', expandNodes: true });
  assert.equal(broken.status, 422);
  assert.ok(broken.generation.diagnostics.some((diagnostic: any) => diagnostic.code === 'loon-outbound-reference-missing'));
  // The provider emits the ordinary node only and does not use the broken managed group.
  const unaffectedProvider = await fetch(`${origin}/s/${profile.token}/source/${ordinary.id}?target=loon`);
  assert.equal(unaffectedProvider.status, 200);
  const providerText = await unaffectedProvider.text();
  assert.match(providerText, / = SOCKS5,ordinary\.runtime\.example,1080.*server-dns="https:\/\/192\.0\.2\.20\/dns-query"/);
  assert.doesNotMatch(providerText, /dependency\.runtime\.example|node:/);
  assert.equal((await api(`/nodes/${dependency.nodes[0].id}`, 'PUT', { enabled: true })).success, true);
  await stopApp(); await startApp();
  assert.equal(await fetch(`${origin}/s/${profile.token}/loon?expand=true`).then(response => response.text()), preview.data);
  assert.equal((await api('/groups')).data.find((group: any) => group.id === requiredGroup.id).name, 'Loon required');
});

test('unsupported native Loon node detours fail clearly rather than emitting a direct connection', async () => {
  bodies.set('/loon-node-route', JSON.stringify({ outbounds: [
    { type: 'socks', tag: 'Routed', server: 'routed.node.example', server_port: 1080, version: '5', detour: 'Exit' },
    { type: 'socks', tag: 'Exit', server: 'exit.node.example', server_port: 1081, version: '5' },
  ] }));
  const source = (await api('/sources', 'POST', { name: 'Loon node route', url: upstreamOrigin + '/loon-node-route' })).data;
  const profile = await profileFor([source]);
  const preview = await api('/generate/preview', 'POST', { profileId: profile.id, customType: 'loon', expandNodes: true });
  assert.equal(preview.status, 422);
  assert.equal(preview.generation.diagnostics[0].code, 'loon-node-route-unapplied');
  assert.equal(preview.generation.diagnostics[0].severity, 'error');
  assert.equal((await fetch(`${origin}/s/${profile.token}/loon?expand=true`)).status, 422);
  assert.equal((await fetch(`${origin}/s/${profile.token}/source/${source.id}?target=loon`)).status, 422);
});

test('Loon adopts native hostname DoH and replaces a conflicting owned template Host mapping', async () => {
  const source = await addSource('/loon-hostname', ['https://resolver.hostname.example/dns-query'], 'node.hostname.example');
  const profile = await profileFor([source]);
  const preview = await api('/generate/preview', 'POST', { profileId: profile.id, customType: 'loon', expandNodes: true });
  assert.equal(preview.success, true, preview.message);
  assert.equal(preview.generation.bindings[0].status, 'applied');
  assert.equal(preview.generation.diagnostics.length, 0);
  assert.match(preview.data, /server-dns="https:\/\/resolver.hostname.example\/dns-query"/);
  assert.doesNotMatch(preview.data, /bootstrap=|dns-policy=|detour=|dns-egress=/);
  const hostTemplate = template.replace('kept.example = 192.0.2.10', 'kept.example = 192.0.2.10\nnode.hostname.example = 192.0.2.99');
  const mappedProfile = await profileFor([source], hostTemplate);
  const mapped = await api('/generate/preview', 'POST', { profileId: mappedProfile.id, customType: 'loon', expandNodes: true });
  assert.equal(mapped.success, true, mapped.message);
  assert.equal(mapped.generation.bindings[0].status, 'applied');
  assert.equal(mapped.generation.bindings[0].method, 'loon-server-dns');
  assert.match(mapped.data, /server-dns=/);
  assert.doesNotMatch(mapped.data, /node\.hostname\.example = 192\.0\.2\.99/);
  assert.match(mapped.data, /kept\.example = 192\.0\.2\.10/);
});

test('successful Loon source DoH removal restores template DNS and provider output after failure and reload', async () => {
  const source = await addSource('/loon-remove', ['https://192.0.2.40/dns-query'], 'node.remove.loon.example');
  const profile = await profileFor([source]);
  const before = await api('/generate/preview', 'POST', { profileId: profile.id, customType: 'loon', expandNodes: true });
  assert.match(before.data, /server-dns=/);
  bodies.set('/loon-remove', 'proxies: [');
  assert.equal((await api(`/sources/${source.id}/refresh`, 'POST', {})).success, false);
  assert.equal((await api('/generate/preview', 'POST', { profileId: profile.id, customType: 'loon', expandNodes: true })).data, before.data);
  bodies.set('/loon-remove', yaml.dump({ proxies: [{ name: 'No DoH', type: 'socks5', server: 'node.remove.loon.example', port: 1080 }] }));
  assert.equal((await api(`/sources/${source.id}/refresh`, 'POST', {})).success, true);
  const removed = await api('/generate/preview', 'POST', { profileId: profile.id, customType: 'loon', expandNodes: true });
  assert.equal(removed.success, true, removed.message);
  assert.equal(removed.generation.bindings[0].status, 'template');
  assert.deepEqual(removed.generation.bindings[0].services, []);
  assert.deepEqual(removed.generation.diagnostics, []);
  assert.doesNotMatch(removed.data, /server-dns=/);
  assert.ok(removed.data.includes(template.split('[Proxy]')[0]));
  const expectedProvider = '[Proxy]\n' + proxyLines(removed.data).join('\n');
  assert.equal(await fetch(`${origin}/s/${profile.token}/source/${source.id}?target=loon`).then(response => response.text()), expectedProvider);
  await stopApp(); await startApp();
  assert.equal(await fetch(`${origin}/s/${profile.token}/loon?expand=true`).then(response => response.text()), removed.data);
});

test('Loon preserves encoded URL data and rejects undocumented list escaping without truncating saved services', async () => {
  const safe = await addSource('/loon-url-safe', ['https://192.0.2.50/dns-query?token=a%2Cb%22'], 'node.url.safe.example');
  const safeProfile = await profileFor([safe]);
  const safePreview = await api('/generate/preview', 'POST', { profileId: safeProfile.id, customType: 'loon', expandNodes: true });
  assert.match(safePreview.data, /server-dns="https:\/\/192\.0\.2\.50\/dns-query\?token=a%2Cb%22"/);
  for (const [index, url] of ['https://192.0.2.51/dns-query?token=a,b', 'https://192.0.2.52/dns-query#DIRECT&h3=true', 'https://user:secret@192.0.2.53/dns-query'].entries()) {
    const source = await addSource(`/loon-url-unsafe-${index}`, ['https://192.0.2.54/first', url], `node.url.${index}.example`);
    const profile = await profileFor([source]);
    const preview = await api('/generate/preview', 'POST', { profileId: profile.id, customType: 'loon', expandNodes: true });
    assert.equal(preview.success, true, preview.message);
    assert.equal(preview.generation.bindings[0].status, 'unapplied');
    assert.equal(preview.generation.diagnostics[0].code, 'source-doh-options-unapplied');
    assert.doesNotMatch(preview.data, /server-dns=/);
    assert.deepEqual((await api('/sources')).data.find((entry: any) => entry.id === source.id).doh.services, source.doh.services);
  }
});

test('Loon preserves ordered Relay members and diagnoses cycles in the actual native group graph', async () => {
  const a = await addSource('/loon-relay-a', [], 'relay.a.example');
  const b = await addSource('/loon-relay-b', [], 'relay.b.example');
  const relay = (await api('/groups', 'POST', { name: 'Loon Relay', type: 'relay', proxies: [`node:${b.nodes[0].id}`, `node:${a.nodes[0].id}`] })).data;
  const profile = await profileFor([a, b], template, { selectedGroupIds: [relay.id] });
  const valid = await api('/generate/preview', 'POST', { profileId: profile.id, customType: 'loon', expandNodes: true });
  assert.equal(valid.success, true, valid.message);
  const lines = proxyLines(valid.data);
  const aName = lines.find(line => line.includes('relay.a.example'))!.split(' = ')[0];
  const bName = lines.find(line => line.includes('relay.b.example'))!.split(' = ')[0];
  assert.ok(valid.data.includes(`Loon Relay = relay, ${bName}, ${aName}`));
  const managed = (await api('/groups', 'POST', { name: 'Managed Cycle', type: 'select', proxies: ['Native cycle'] })).data;
  const cyclic = await profileFor([a], template.replace('[Proxy Group]\n', '[Proxy Group]\nNative cycle = select, Managed Cycle\n'), { selectedGroupIds: [managed.id] });
  const broken = await api('/generate/preview', 'POST', { profileId: cyclic.id, customType: 'loon', expandNodes: true });
  assert.equal(broken.status, 422);
  assert.ok(broken.generation.diagnostics.some((diagnostic: any) => diagnostic.code === 'source-doh-cycle'));
  assert.equal((await fetch(`${origin}/s/${cyclic.token}/loon?expand=true`)).status, 422);
});

test('Loon diagnoses a disabled stable remote-rule node reference even when no ordinary nodes remain', async () => {
  const source = await addSource('/loon-remote-rule', [], 'node.remote-rule.example');
  await api(`/nodes/${source.nodes[0].id}`, 'PUT', { name: 'Loon remote rule node' });
  const content = template + '\n[Remote Rule]\nhttps://rules.example/list, policy=Loon remote rule node, enabled=true\n';
  const profile = await profileFor([source], content);
  assert.equal((await api('/generate/preview', 'POST', { profileId: profile.id, customType: 'loon', expandNodes: true })).success, true);
  await api(`/nodes/${source.nodes[0].id}`, 'PUT', { enabled: false });
  const broken = await api('/generate/preview', 'POST', { profileId: profile.id, customType: 'loon', expandNodes: true });
  assert.equal(broken.status, 422);
  assert.equal(broken.generation.nodeCount, 0);
  assert.equal(broken.generation.diagnostics[0].code, 'loon-outbound-reference-missing');
  await api(`/nodes/${source.nodes[0].id}`, 'PUT', { enabled: true, name: 'Renamed remote rule node' });
  const repaired = await api('/generate/preview', 'POST', { profileId: profile.id, customType: 'loon', expandNodes: true });
  assert.equal(repaired.success, true, repaired.message);
  assert.match(repaired.data, /policy=Renamed remote rule node, enabled=true/);
  assert.equal((await api('/templates')).data.find((entry: any) => entry.id === profile.templates.loon).content, content);
});

test('QuanX DoH URLs project onto the source nodes in Loon regardless of the original DNS scope', async () => {
  const path = '/loon-quanx';
  const node = '[server_local]\nshadowsocks=quanx.node.example:443, method=aes-128-gcm, password=secret, tag=QuanX Loon\n[dns]\n';
  bodies.set(path, node + 'doh-server = https://192.0.2.60/one, https://192.0.2.61/two\n');
  const source = (await api('/sources', 'POST', { name: 'QuanX Loon', url: upstreamOrigin + path })).data;
  const profile = await profileFor([source]);
  const projected = await api('/generate/preview', 'POST', { profileId: profile.id, customType: 'loon', expandNodes: true });
  assert.equal(projected.success, true, projected.message);
  assert.match(projected.data, /server-dns="https:\/\/192.0.2.60\/one,https:\/\/192.0.2.61\/two"/);
  assert.equal(projected.generation.bindings[0].status, 'applied');
  bodies.set(path, node + 'doh-server = /*.private.example/https://192.0.2.62/dns-query\n');
  assert.equal((await api(`/sources/${source.id}/refresh`, 'POST', {})).success, true);
  const scoped = await api('/generate/preview', 'POST', { profileId: profile.id, customType: 'loon', expandNodes: true });
  assert.equal(scoped.generation.bindings[0].status, 'applied');
  assert.match(scoped.data, /server-dns="https:\/\/192.0.2.62\/dns-query"/);
});
