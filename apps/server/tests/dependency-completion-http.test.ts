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
const userinfos = new Map<string, string>();
const upstream = createServer((request, response) => {
  const info = userinfos.get(request.url || '/');
  if (info) response.setHeader('subscription-userinfo', info);
  response.end(bodies.get(request.url || '/') || 'proxies: []');
});
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
  dns: { servers: [{ type: 'udp', tag: 'bootstrap', server: '127.0.0.1', server_port: 54535 }], final: 'bootstrap' },
  route: { default_domain_resolver: { server: 'bootstrap' } },
  outbounds: [{ type: 'direct', tag: 'template-direct' }],
};
async function addSource(path: string, document: unknown) {
  bodies.set(path, JSON.stringify(document));
  const added = await api('/sources', 'POST', { name: path.slice(1), url: upstreamOrigin + path });
  assert.equal(added.success, true, JSON.stringify(added));
  return added.data;
}
async function profileFor(nodes: any[], content: unknown = template) {
  const group = (await api('/groups', 'POST', { name: `Ordinary-${Math.random()}`, type: 'select', includeAll: true })).data;
  const tpl = (await api('/templates', 'POST', { name: 'Completion template', type: 'singbox', content: JSON.stringify(content) })).data;
  const profile = (await api('/profiles', 'POST', { name: 'Completion profile', nodeFilter: { mode: 'manual', selectedNodeIds: nodes.map(node => node.id) }, selectedGroupIds: [group.id], templates: { singbox: tpl.id } })).data;
  return { ...profile, group, tpl };
}
const preview = (profile: any, customType = 'singbox', extra = {}) => api('/generate/preview', 'POST', { profileId: profile.id, customType, ...extra });

test('omitted eligible DoH egress is dependency-only in preview, full, provider and pure outputs', async () => {
  const added = await addSource('/omitted-egress', {
    outbounds: [
      { type: 'shadowsocks', tag: 'Ordinary node', server: 'ordinary.completion.example', server_port: 443, method: 'aes-128-gcm', password: 'dummy' },
      { type: 'socks', tag: 'DNS exit', server: '192.0.2.21', server_port: 1080 },
      { type: 'socks', tag: 'Unselected other', server: '192.0.2.22', server_port: 1080 },
    ], dns: { servers: [{ type: 'https', server: '192.0.2.53', detour: 'DNS exit' }] },
  });
  const ordinary = added.nodes.find((node: any) => node.server === 'ordinary.completion.example');
  const exit = added.nodes.find((node: any) => node.server === '192.0.2.21');
  const profile = await profileFor([ordinary]);
  const result = await preview(profile);
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.generation.nodeCount, 1);
  assert.equal(result.generation.dependencyNodeCount, 1);
  assert.deepEqual(result.generation.bindings[0].nodeIds.sort(), [ordinary.id, exit.id].sort());
  assert.deepEqual(result.generation.dependencyNodes.map((node: any) => [node.id, node.name, node.sourceId, node.sourceName]), [[exit.id, 'DNS exit', added.id, added.name]]);
  assert.ok(result.generation.dependencyNodes[0].reason.length);
  assert.doesNotMatch(JSON.stringify(result.generation.dependencyNodes), /server_port|password|raw/);
  const doc = JSON.parse(result.data);
  assert.deepEqual(doc.outbounds.filter((entry: any) => entry.server).map((entry: any) => entry.server).sort(), ['192.0.2.21', 'ordinary.completion.example']);
  assert.deepEqual(doc.outbounds.find((entry: any) => entry.tag === profile.group.name).outbounds, ['Ordinary node']);
  assert.equal(doc.outbounds.find((entry: any) => entry.tag === 'GLOBAL').outbounds.includes('DNS exit'), false);
  const full = await fetch(`${origin}/s/${profile.token}/singbox`);
  assert.equal(full.status, 200);
  assert.equal(await full.text(), result.data);
  const provider = await fetch(`${origin}/s/${profile.token}/source/${added.id}/mihomo`).then(response => response.text());
  assert.match(provider, /Ordinary node/);
  assert.doesNotMatch(provider, /DNS exit|Unselected other/);
  const pure = await fetch(`${origin}/s/${profile.token}/shadowrocket?format=base64`).then(response => response.text());
  assert.match(Buffer.from(pure, 'base64').toString(), /Ordinary/);
  assert.doesNotMatch(Buffer.from(pure, 'base64').toString(), /DNS%20exit|192\.0\.2\.21/);
  assert.deepEqual((await api('/profiles')).data.find((entry: any) => entry.id === profile.id).nodeFilter.selectedNodeIds, [ordinary.id]);
});

test('completion reaches a newly required source binding and isolates its required managed group', async () => {
  const egress = await addSource('/second-source', { outbounds: [
    { type: 'socks', tag: 'Second source hop', server: 'second-hop.completion.example', server_port: 1080 },
    { type: 'socks', tag: 'Final IP exit', server: '192.0.2.31', server_port: 1080 },
    { type: 'socks', tag: 'Never selected', server: '192.0.2.32', server_port: 1080 },
  ], dns: { servers: [{ type: 'https', server: '192.0.2.54', detour: 'Final IP exit' }] } });
  const hop = egress.nodes.find((node: any) => node.server === 'second-hop.completion.example');
  const exit = egress.nodes.find((node: any) => node.server === '192.0.2.31');
  const dependencyGroup = (await api('/groups', 'POST', { name: 'Required bootstrap choice', type: 'select', sources: [egress.id], filter: '^Second source hop$' })).data;
  const first = await addSource('/first-source', { outbounds: [{ type: 'socks', tag: 'First ordinary', server: 'first.completion.example', server_port: 1080 }], dns: { servers: [{ type: 'https', server: 'dns.first.completion.example' }] } });
  const content = structuredClone(template);
  (content.dns.servers[0] as any).detour = dependencyGroup.name;
  const profile = await profileFor(first.nodes, content);
  const result = await preview(profile);
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.generation.nodeCount, 1);
  assert.equal(result.generation.dependencyNodeCount, 2);
  assert.deepEqual(result.generation.dependencyNodes.map((node: any) => node.id).sort(), [hop.id, exit.id].sort());
  const binding = result.generation.bindings.find((binding: any) => binding.sourceId === egress.id);
  assert.equal(binding.status, 'applied');
  assert.deepEqual(binding.nodeIds.sort(), [hop.id, exit.id].sort());
  const doc = JSON.parse(result.data);
  assert.deepEqual(doc.outbounds.find((entry: any) => entry.tag === profile.group.name).outbounds, ['First ordinary']);
  assert.deepEqual(doc.outbounds.find((entry: any) => entry.tag === 'GLOBAL').outbounds, [profile.group.name, 'First ordinary']);
  assert.equal(doc.outbounds.find((entry: any) => entry.tag === dependencyGroup.name).outbounds[0], 'Second source hop');
  assert.equal(doc.dns.servers.find((entry: any) => entry.server === '192.0.2.54').detour, 'Final IP exit');
  assert.equal(await fetch(`${origin}/s/${profile.token}/source/${egress.id}/mihomo`).then(response => response.text()), 'proxies: []\n');
  await stopApp(); await startApp();
  assert.deepEqual((await preview(profile)).generation.dependencyNodes, result.generation.dependencyNodes);
});

test('disabled, information-only and deleted egress never revive, while deliberate stable repairs recover after reload', async () => {
  const egressDoc = { outbounds: [{ type: 'socks', tag: 'Lifecycle exit', server: '192.0.2.41', server_port: 1080 }] };
  const egress = await addSource('/lifecycle-egress', egressDoc);
  const exit = egress.nodes[0];
  const group = (await api('/groups', 'POST', { name: 'Lifecycle DNS choice', type: 'select', proxies: [`node:${exit.id}`] })).data;
  const first = await addSource('/lifecycle-first', { outbounds: [{ type: 'shadowsocks', tag: 'Lifecycle ordinary', server: 'lifecycle.completion.example', server_port: 443, method: 'aes-128-gcm', password: 'dummy' }], dns: { servers: [{ type: 'https', server: 'dns.lifecycle.example' }] } });
  const content = structuredClone(template);
  (content.dns.servers[0] as any).detour = group.name;
  const profile = await profileFor(first.nodes, content);
  const safe = await profileFor([exit]);
  assert.equal((await preview(profile)).success, true);
  await api(`/nodes/${exit.id}`, 'PUT', { enabled: false });
  assert.equal((await preview(profile)).status, 422);
  assert.equal((await api('/groups')).data.find((entry: any) => entry.id === group.id).proxies[0], `node:${exit.id}`);
  assert.equal((await fetch(`${origin}/s/${profile.token}/shadowrocket?format=base64`)).status, 200);
  await api(`/nodes/${exit.id}`, 'PUT', { enabled: true });
  assert.equal((await preview(profile)).success, true);
  await api(`/sources/${egress.id}`, 'PUT', { enabled: false });
  assert.equal((await preview(profile)).status, 422);
  await api(`/sources/${egress.id}`, 'PUT', { enabled: true });
  assert.equal((await preview(profile)).success, true);
  await api(`/sources/${egress.id}`, 'PUT', { trafficNodeRegex: 'Lifecycle exit' });
  assert.equal((await preview(profile)).status, 422);
  assert.equal((await source(egress.id)).infoNodes[0].id, exit.id);
  await api(`/sources/${egress.id}`, 'PUT', { trafficNodeRegex: '' });
  assert.equal((await preview(profile)).success, true);
  assert.equal((await preview(safe)).success, true);
  assert.equal((await api(`/sources/${egress.id}`, 'DELETE')).success, true);
  assert.equal((await preview(profile)).status, 422);
  assert.deepEqual((await api('/groups')).data.find((entry: any) => entry.id === group.id).proxies, ['unresolved:Lifecycle exit']);
  assert.equal((await api('/nodes')).data.some((node: any) => node.id === exit.id), false);
  const replacement = await addSource('/lifecycle-egress', egressDoc);
  assert.notEqual(replacement.nodes[0].id, exit.id);
  assert.equal((await preview(profile)).status, 422);
  await stopApp(); await startApp();
  assert.equal((await preview(profile)).status, 422);
  await api(`/groups/${group.id}`, 'PUT', { proxies: [`node:${replacement.nodes[0].id}`] });
  assert.equal((await preview(profile)).success, true);
  await api(`/groups/${group.id}`, 'DELETE');
  assert.equal((await preview(profile)).status, 422);
  const newGroup = (await api('/groups', 'POST', { name: group.name, type: 'select', proxies: [`node:${replacement.nodes[0].id}`] })).data;
  assert.notEqual(newGroup.id, group.id);
  assert.equal((await preview(profile)).status, 422);
  (content.dns.servers[0] as any).detour = `group:${newGroup.id}`;
  await api(`/templates/${profile.tpl.id}`, 'PUT', { content: JSON.stringify(content) });
  assert.equal((await preview(profile)).success, true);
});

test('successful DoH replacement and removal change completion atomically while failed updates keep it after reload', async () => {
  const outbounds = [
    { type: 'socks', tag: 'Update ordinary', server: 'update.completion.example', server_port: 1080 },
    { type: 'socks', tag: 'Old DNS exit', server: '192.0.2.61', server_port: 1080 },
    { type: 'socks', tag: 'New DNS exit', server: '192.0.2.62', server_port: 1080 },
  ];
  const added = await addSource('/updates', { outbounds, dns: { servers: [{ type: 'https', server: '192.0.2.53', detour: 'Old DNS exit' }] } });
  const profile = await profileFor([added.nodes[0]]);
  const original = await preview(profile);
  assert.equal(original.success, true);
  assert.deepEqual(original.generation.dependencyNodes.map((node: any) => node.name), ['Old DNS exit']);
  bodies.set('/updates', JSON.stringify({ outbounds: [{ type: 'socks', tag: 'Bad', server_port: 1080 }], dns: { servers: [{ type: 'https', server: '192.0.2.54', detour: 'New DNS exit' }] } }));
  assert.equal((await api(`/sources/${added.id}/refresh`, 'POST')).status, 422);
  await stopApp(); await startApp();
  assert.equal((await preview(profile)).data, original.data);
  assert.deepEqual((await source(added.id)).doh, added.doh);
  bodies.set('/updates', JSON.stringify({ outbounds, dns: { servers: [{ type: 'https', server: '192.0.2.54', detour: 'New DNS exit' }] } }));
  assert.equal((await api(`/sources/${added.id}/refresh`, 'POST')).success, true);
  const changed = await preview(profile);
  assert.equal(changed.success, true);
  assert.deepEqual(changed.generation.dependencyNodes.map((node: any) => node.name), ['New DNS exit']);
  assert.equal(JSON.parse(changed.data).outbounds.some((entry: any) => entry.server === '192.0.2.61'), false);
  bodies.set('/updates', JSON.stringify({ outbounds }));
  assert.equal((await api(`/sources/${added.id}/refresh`, 'POST')).success, true);
  await stopApp(); await startApp();
  const removed = await preview(profile);
  assert.equal(removed.success, true);
  assert.equal(removed.generation.dependencyNodeCount, 0);
  assert.equal(removed.generation.bindings[0].status, 'template');
  assert.deepEqual(JSON.parse(removed.data).dns, template.dns);
});

test('source replacement deleting the last required managed member retains repair intent without direct fallback', async () => {
  const egress = await addSource('/replaced-egress', { outbounds: [{ type: 'socks', tag: 'Removed last member', server: '192.0.2.71', server_port: 1080 }] });
  const group = (await api('/groups', 'POST', { name: 'Replacement choice', type: 'select', proxies: [`node:${egress.nodes[0].id}`] })).data;
  const first = await addSource('/replacement-first', { outbounds: [{ type: 'socks', tag: 'Replacement ordinary', server: 'replacement.completion.example', server_port: 1080 }], dns: { servers: [{ type: 'https', server: 'dns.replacement.example' }] } });
  const content = structuredClone(template); (content.dns.servers[0] as any).detour = group.name;
  const profile = await profileFor(first.nodes, content);
  assert.equal((await preview(profile)).success, true);
  bodies.set('/replaced-egress', JSON.stringify({ outbounds: [] }));
  assert.equal((await api(`/sources/${egress.id}/refresh`, 'POST')).success, true);
  assert.equal((await preview(profile)).status, 422);
  assert.deepEqual((await api('/groups')).data.find((entry: any) => entry.id === group.id).proxies, ['unresolved:Removed last member']);
  bodies.set('/replaced-egress', JSON.stringify({ outbounds: [{ type: 'socks', tag: 'Removed last member', server: '192.0.2.71', server_port: 1080 }] }));
  await api(`/sources/${egress.id}/refresh`, 'POST');
  const replacement = (await source(egress.id)).nodes[0];
  assert.notEqual(replacement.id, egress.nodes[0].id);
  assert.equal((await preview(profile)).status, 422);
  await api(`/groups/${group.id}`, 'PUT', { proxies: [`node:${replacement.id}`] });
  assert.equal((await preview(profile)).success, true);
});

test('final graph rechecks a cycle introduced by a dependency-only source binding', async () => {
  const egress = await addSource('/closure-cycle-egress', { outbounds: [{ type: 'socks', tag: 'Cyclic dependency hop', server: 'cyclic-dependency.example', server_port: 1080 }], dns: { servers: [{ type: 'https', server: '192.0.2.53', detour: 'Cyclic dependency hop' }] } });
  const first = await addSource('/closure-cycle-first', { outbounds: [{ type: 'socks', tag: 'Cycle ordinary', server: 'closure-cycle.example', server_port: 1080 }], dns: { servers: [{ type: 'https', server: 'dns.closure-cycle.example' }] } });
  const content = structuredClone(template); (content.dns.servers[0] as any).detour = `node:${egress.nodes[0].id}`;
  const profile = await profileFor(first.nodes, content);
  const result = await preview(profile);
  assert.equal(result.status, 422);
  assert.equal(result.generation.nodeCount, 1);
  assert.equal(result.generation.dependencyNodeCount, 1);
  assert.ok(result.generation.diagnostics.some((entry: any) => entry.code === 'source-doh-cycle' && /Cyclic dependency hop.*192.0.2.53.*Cyclic dependency hop/.test(entry.message)), JSON.stringify(result));
  assert.equal((await fetch(`${origin}/s/${profile.token}/singbox`)).status, 422);
});


test('subscription usage counts ordinary sources and never a dependency-only source', async () => {
  userinfos.set('/usage-egress', 'upload=300; download=400; total=9000');
  const egress = await addSource('/usage-egress', { outbounds: [{ type: 'socks', tag: 'Usage dependency', server: '192.0.2.81', server_port: 1080 }] });
  userinfos.set('/usage-ordinary', 'upload=10; download=20; total=1000');
  const ordinary = await addSource('/usage-ordinary', { outbounds: [{ type: 'socks', tag: 'Usage ordinary', server: 'usage.completion.example', server_port: 1080 }], dns: { servers: [{ type: 'https', server: 'dns.usage.example' }] } });
  const content = structuredClone(template); (content.dns.servers[0] as any).detour = `node:${egress.nodes[0].id}`;
  const profile = await profileFor(ordinary.nodes, content);
  const full = await fetch(`${origin}/s/${profile.token}/singbox`);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('subscription-userinfo'), 'upload=10; download=20; total=1000');
  const provider = await fetch(`${origin}/s/${profile.token}/source/${egress.id}/mihomo`);
  assert.equal(await provider.text(), 'proxies: []\n');
  assert.equal(provider.headers.get('subscription-userinfo'), null);
});

test('completion follows stable identities even when required group and template tags collide', async () => {
  const egress = await addSource('/collision-egress', { outbounds: [{ type: 'socks', tag: 'Collision exit', server: '192.0.2.91', server_port: 1080 }] });
  const group = (await api('/groups', 'POST', { name: 'Template collision', type: 'select', proxies: [`node:${egress.nodes[0].id}`] })).data;
  const ordinary = await addSource('/collision-ordinary', { outbounds: [{ type: 'socks', tag: 'Collision ordinary', server: 'collision.completion.example', server_port: 1080 }], dns: { servers: [{ type: 'https', server: 'dns.collision.example' }] } });
  const content = structuredClone(template);
  content.outbounds.push({ type: 'direct', tag: group.name });
  (content.dns.servers[0] as any).detour = `group:${group.id}`;
  const profile = await profileFor(ordinary.nodes, content);
  await api(`/profiles/${profile.id}`, 'PUT', { selectedGroupIds: [profile.group.id, group.id] });
  const result = await preview(profile);
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.generation.dependencyNodeCount, 1);
  const doc = JSON.parse(result.data);
  const managed = doc.outbounds.find((entry: any) => entry.type === 'selector' && entry.outbounds.includes('Collision exit'));
  assert.ok(managed);
  assert.notEqual(managed.tag, group.name);
  assert.equal(doc.dns.servers.find((entry: any) => entry.tag === 'bootstrap').detour, managed.tag);
});

test('managed rule outbounds follow group rename and keep deletion repair intent instead of a same-name replacement', async () => {
  const added = await addSource('/rule-reference', { outbounds: [{ type: 'socks', tag: 'Rule ordinary', server: '192.0.2.101', server_port: 1080 }] });
  const profile = await profileFor(added.nodes);
  const rule = (await api('/rules/unified', 'POST', { name: 'Stable group rule', kind: 'local', type: 'DOMAIN', payload: 'stable-rule.example', outbound: profile.group.name, enabled: true })).data;
  await api(`/profiles/${profile.id}`, 'PUT', { selectedRuleIds: [rule.id] });
  await api(`/groups/${profile.group.id}`, 'PUT', { name: 'Renamed rule group' });
  const renamed = await preview(profile);
  assert.equal(renamed.success, true);
  assert.equal((await api('/rules/unified')).data.find((entry: any) => entry.id === rule.id).outbound, 'Renamed rule group');
  assert.ok(JSON.parse(renamed.data).route.rules.some((entry: any) => entry.domain?.includes('stable-rule.example') && entry.outbound === 'Renamed rule group'), renamed.data);
  await api(`/groups/${profile.group.id}`, 'DELETE');
  assert.equal((await api('/rules/unified')).data.find((entry: any) => entry.id === rule.id).outbound, 'unresolved:Renamed rule group');
  const replacement = (await api('/groups', 'POST', { name: 'Renamed rule group', type: 'select', includeAll: true })).data;
  assert.notEqual(replacement.id, profile.group.id);
  assert.equal((await api('/rules/unified')).data.find((entry: any) => entry.id === rule.id).outbound, 'unresolved:Renamed rule group');
});

test('native node detours complete independently of absent source DoH and retain private strategies', async () => {
  const added = await addSource('/native-detour-without-doh', { outbounds: [
    { type: 'socks', tag: 'Native chain ordinary', server: 'native-chain.example', server_port: 1080, detour: 'Native chain choice' },
    { type: 'selector', tag: 'Native chain choice', outbounds: ['Native chain exit'] },
    { type: 'socks', tag: 'Native chain exit', server: '192.0.2.111', server_port: 1080 },
  ] });
  const ordinary = added.nodes.find((node: any) => node.server === 'native-chain.example');
  const profile = await profileFor([ordinary]);
  const result = await preview(profile);
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.generation.nodeCount, 1);
  assert.equal(result.generation.dependencyNodeCount, 1);
  const doc = JSON.parse(result.data);
  const node = doc.outbounds.find((entry: any) => entry.tag === 'Native chain ordinary');
  const choice = doc.outbounds.find((entry: any) => entry.tag === node.detour);
  assert.equal(choice.type, 'selector');
  assert.deepEqual(choice.outbounds, ['Native chain exit']);
  assert.deepEqual(doc.outbounds.find((entry: any) => entry.tag === profile.group.name).outbounds, ['Native chain ordinary']);
});
