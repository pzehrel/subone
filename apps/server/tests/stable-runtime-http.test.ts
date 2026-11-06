import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import yaml from 'js-yaml';

let directory: string;
let child: ChildProcess;
let origin: string;
let upstreamOrigin: string;
const upstreamBodies = new Map<string, string>();
const upstream = createServer((request, response) => response.end(upstreamBodies.get(request.url || '/') || JSON.stringify({ outbounds: [
  { type: 'socks', tag: 'Stable node', server: '192.0.2.20', server_port: 1080 },
] })));
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
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'subone-stable-runtime-'));
  await writeFile(join(directory, 'config.json'), JSON.stringify({ port: 3456, adminPassword: '' }));
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const address = upstream.address(); assert.ok(address && typeof address !== 'string');
  upstreamOrigin = `http://127.0.0.1:${address.port}`; await startApp();
});
after(async () => { await stopApp(); await new Promise<void>(resolve => upstream.close(() => resolve())); await rm(directory, { recursive: true, force: true }); });

test('an untouched packaged template binds its current managed target before the first rename', async () => {
  const tpl = (await api('/templates')).data.find((entry: any) => entry.id === 'tpl-singbox-default');
  assert.equal(tpl.connectionReferences, undefined);
  const content = JSON.parse(tpl.content);
  const group = (await api('/groups')).data.find((entry: any) => entry.name === content.route.final);
  assert.ok(group, 'the packaged default route names an initial managed group');
  assert.equal((await api(`/groups/${group.id}`, 'PUT', { name: 'Renamed packaged default' })).success, true);
  const profile = (await api('/profiles', 'POST', { name: 'Packaged identity', nodeFilter: { mode: 'manual', selectedNodeIds: [] }, selectedGroupIds: [group.id], templates: { singbox: tpl.id } })).data;
  await stopApp(); await startApp();
  const response = await fetch(`${origin}/s/${profile.token}/singbox`);
  assert.equal(response.status, 200);
  assert.equal((await response.json() as any).route.final, 'Renamed packaged default');
  assert.equal((await api('/templates')).data.find((entry: any) => entry.id === tpl.id).content, tpl.content);
});

test('managed group selection follows stable nested groups after rename and reload', async () => {
  const source = (await api('/sources', 'POST', { name: 'Stable source', url: upstreamOrigin })).data;
  const inner = (await api('/groups', 'POST', { name: 'Stable inner', type: 'select', proxies: ['Stable node'] })).data;
  const outer = (await api('/groups', 'POST', { name: 'Stable outer', type: 'select', proxies: ['Stable inner'] })).data;
  assert.deepEqual(outer.proxies, [`group:${inner.id}`]);
  const tpl = (await api('/templates', 'POST', { name: 'Stable group template', type: 'singbox', content: JSON.stringify({ outbounds: [{ type: 'direct', tag: 'direct' }] }) })).data;
  const profile = (await api('/profiles', 'POST', { name: 'Stable groups', nodeFilter: { mode: 'all', sourceIds: [source.id] }, selectedGroupIds: [outer.id], templates: { singbox: tpl.id } })).data;
  assert.equal((await api(`/groups/${inner.id}`, 'PUT', { name: 'Renamed inner' })).success, true);
  await stopApp(); await startApp();
  const response = await fetch(`${origin}/s/${profile.token}/singbox`);
  assert.equal(response.status, 200);
  const doc = await response.json() as any;
  assert.deepEqual(doc.outbounds.find((entry: any) => entry.tag === 'Stable outer').outbounds, ['Renamed inner']);
  assert.deepEqual(doc.outbounds.find((entry: any) => entry.tag === 'Renamed inner').outbounds, ['Stable node']);
});

test('template connection references keep managed targets through rename, unchanged save and reload', async () => {
  const source = (await api('/sources')).data.find((entry: any) => entry.name === 'Stable source');
  const managed = (await api('/groups', 'POST', { name: 'Managed template exit', type: 'select', proxies: ['Stable node'] })).data;
  const shadowed = (await api('/groups', 'POST', { name: 'template-owned', type: 'direct' })).data;
  const content = JSON.stringify({
    dns: { servers: [{ type: 'https', tag: 'template-dns', server: '192.0.2.53', detour: 'Managed template exit', headers: { 'X-Note': 'Stable node' } }] },
    outbounds: [
      { type: 'direct', tag: 'template-owned' },
      { type: 'socks', tag: 'template-wrapper', server: '192.0.2.30', server_port: 1080, detour: 'Stable node' },
      { type: 'selector', tag: 'template-selector', outbounds: ['Managed template exit', 'Stable node', 'template-owned'] },
    ],
    route: { final: 'Managed template exit', rules: [{ domain: ['kept.template.example'], outbound: 'Managed template exit' }] },
  });
  const tpl = (await api('/templates', 'POST', { name: 'Bound connections', type: 'singbox', content })).data;
  const profile = (await api('/profiles', 'POST', { name: 'Template references', nodeFilter: { mode: 'all', sourceIds: [source.id] }, selectedGroupIds: [managed.id], templates: { singbox: tpl.id } })).data;
  assert.equal((await api(`/nodes/${source.nodes[0].id}`, 'PUT', { name: 'Renamed template node' })).success, true);
  assert.equal((await api(`/groups/${managed.id}`, 'PUT', { name: 'Renamed template exit' })).success, true);
  assert.equal((await api(`/groups/${shadowed.id}`, 'PUT', { name: 'Renamed shadowed group' })).success, true);
  assert.equal((await api(`/templates/${tpl.id}`, 'PUT', { content })).success, true);
  await stopApp(); await startApp();
  const preview = await api('/generate/preview', 'POST', { profileId: profile.id, customType: 'singbox' });
  assert.equal(preview.success, true, preview.message);
  const doc = JSON.parse(preview.data);
  assert.equal(doc.dns.servers.find((entry: any) => entry.tag === 'template-dns').detour, 'Renamed template exit');
  assert.equal(doc.outbounds.find((entry: any) => entry.tag === 'template-wrapper').detour, 'Renamed template node');
  assert.deepEqual(doc.outbounds.find((entry: any) => entry.tag === 'template-selector').outbounds, ['Renamed template exit', 'Renamed template node', 'template-owned']);
  assert.equal(doc.route.final, 'Renamed template exit');
  assert.equal(doc.route.rules.find((rule: any) => rule.domain?.[0] === 'kept.template.example').outbound, 'Renamed template exit');
  assert.deepEqual(doc.dns.servers[0].headers, { 'X-Note': 'Stable node' });
  assert.equal((await api('/templates')).data.find((entry: any) => entry.id === tpl.id).content, content);
  assert.equal(await fetch(`${origin}/s/${profile.token}/singbox`).then(response => response.text()), preview.data);
});

test('deleted managed targets remain repair references when an equal name is recreated', async () => {
  const source = (await api('/sources')).data.find((entry: any) => entry.name === 'Stable source');
  const member = (await api('/groups', 'POST', { name: 'Deletion member', type: 'select', proxies: [`node:${source.nodes[0].id}`] })).data;
  const target = (await api('/groups', 'POST', { name: 'Deletion exit', type: 'direct' })).data;
  const outer = (await api('/groups', 'POST', { name: 'Deletion outer', type: 'select', proxies: ['Deletion exit'] })).data;
  const content = JSON.stringify({ dns: { servers: [{ type: 'https', tag: 'deleted-egress', server: '192.0.2.53', detour: 'Deletion exit' }] }, outbounds: [{ type: 'socks', tag: 'deleted-node-egress', server: '192.0.2.30', server_port: 1080, detour: 'Renamed template node' }] });
  const tpl = (await api('/templates', 'POST', { name: 'Deleted connections', type: 'singbox', content })).data;
  assert.equal((await api(`/groups/${target.id}`, 'DELETE')).success, true);
  assert.equal((await api(`/sources/${source.id}`, 'DELETE')).success, true);
  const groups = (await api('/groups')).data;
  assert.deepEqual(groups.find((group: any) => group.id === member.id).proxies, ['unresolved:Renamed template node']);
  assert.deepEqual(groups.find((group: any) => group.id === outer.id).proxies, ['unresolved:Deletion exit']);
  await api('/groups', 'POST', { name: 'Deletion exit', type: 'direct' });
  const replacement = (await api('/sources', 'POST', { name: 'Replacement source', url: upstreamOrigin })).data;
  await api(`/nodes/${replacement.nodes[0].id}`, 'PUT', { name: 'Renamed template node' });
  const saved = await api(`/templates/${tpl.id}`, 'PUT', { content });
  assert.deepEqual(saved.data.connectionReferences.map((reference: any) => reference.target).sort(), ['unresolved:Deletion exit', 'unresolved:Renamed template node']);
  await stopApp(); await startApp();
  const reloaded = (await api('/templates')).data.find((template: any) => template.id === tpl.id);
  assert.deepEqual(reloaded.connectionReferences, saved.data.connectionReferences);
  assert.equal(reloaded.content, content);
});

test('template-owned outbounds keep their namespace when a selected managed group has the same name', async () => {
  const source = (await api('/sources')).data.find((entry: any) => entry.name === 'Replacement source');
  const managed = (await api('/groups', 'POST', { name: 'template-protected', type: 'direct' })).data;
  const outer = (await api('/groups', 'POST', { name: 'Protected outer', type: 'select', proxies: [`group:${managed.id}`] })).data;
  const content = JSON.stringify({
    dns: { servers: [{ type: 'https', tag: 'owned-egress-dns', server: '192.0.2.53', detour: 'template-protected' }] },
    outbounds: [{ type: 'socks', tag: 'template-protected', server: '192.0.2.41', server_port: 1080 }],
    route: { final: 'template-protected' },
  });
  const tpl = (await api('/templates', 'POST', { name: 'Protected namespace', type: 'singbox', content })).data;
  const profile = (await api('/profiles', 'POST', { name: 'Protected namespace profile', nodeFilter: { mode: 'all', sourceIds: [source.id] }, selectedGroupIds: [outer.id], templates: { singbox: tpl.id } })).data;
  const response = await fetch(`${origin}/s/${profile.token}/singbox`);
  assert.equal(response.status, 200);
  const doc = await response.json() as any;
  assert.equal(doc.outbounds.find((entry: any) => entry.tag === 'template-protected').server, '192.0.2.41');
  assert.deepEqual(doc.outbounds.find((entry: any) => entry.tag === 'Protected outer').outbounds, ['template-protected (2)']);
  assert.equal(doc.outbounds.find((entry: any) => entry.tag === 'template-protected (2)').type, 'direct');
  assert.equal(doc.dns.servers[0].detour, 'template-protected');
  assert.equal(doc.route.final, 'template-protected');
});

test('a disabled explicit managed member remains a required broken path instead of disappearing into direct fallback', async () => {
  upstreamBodies.set('/disabled-managed-egress', JSON.stringify({
    outbounds: [
      { type: 'socks', tag: 'Adopted managed node', server: 'managed.node.example', server_port: 1080 },
      { type: 'socks', tag: 'Required managed exit', server: '192.0.2.51', server_port: 1080 },
    ], dns: { servers: [{ type: 'https', server: 'managed.doh.example' }] },
  }));
  const source = (await api('/sources', 'POST', { name: 'Managed dependency source', url: upstreamOrigin + '/disabled-managed-egress' })).data;
  const required = source.nodes.find((node: any) => node.name === 'Required managed exit');
  const ordinary = source.nodes.find((node: any) => node.name === 'Adopted managed node');
  const group = (await api('/groups', 'POST', { name: 'Required managed group', type: 'select', proxies: [`node:${required.id}`] })).data;
  const tpl = (await api('/templates', 'POST', { name: 'Managed bootstrap', type: 'singbox', content: JSON.stringify({
    dns: { servers: [{ type: 'udp', tag: 'managed-bootstrap', server: '192.0.2.53', detour: 'Required managed group' }] },
    route: { default_domain_resolver: { server: 'managed-bootstrap' } },
  }) })).data;
  const profile = (await api('/profiles', 'POST', { name: 'Disabled managed path', nodeFilter: { mode: 'manual', selectedNodeIds: [ordinary.id] }, selectedGroupIds: [group.id], templates: { singbox: tpl.id } })).data;
  assert.equal((await api(`/nodes/${required.id}`, 'PUT', { enabled: false })).success, true);
  const preview = await api('/generate/preview', 'POST', { profileId: profile.id, customType: 'singbox' });
  assert.equal(preview.status, 422);
  const diagnostic = preview.generation.diagnostics.find((entry: any) => entry.code === 'source-doh-dependency-missing');
  assert.ok(diagnostic, JSON.stringify(preview.generation.diagnostics));
  assert.equal(diagnostic.path.at(-1).id, `node:${required.id}`);
  assert.deepEqual((await api('/groups')).data.find((entry: any) => entry.id === group.id).proxies, [`node:${required.id}`]);
  assert.equal((await fetch(`${origin}/s/${profile.token}/singbox`)).status, 422);
});

test('Mihomo DNS egress identity survives insertion of an unrelated resolver after a managed rename', async () => {
  const source = (await api('/sources')).data.find((entry: any) => entry.name === 'Replacement source');
  const group = (await api('/groups', 'POST', { name: 'Mihomo stable exit', type: 'direct' })).data;
  const document = { dns: { enable: true, nameserver: ['https://mihomo.identity.example/query#Mihomo stable exit'] } };
  const tpl = (await api('/templates', 'POST', { name: 'Mihomo egress identity', type: 'mihomo', content: JSON.stringify(document) })).data;
  const profile = (await api('/profiles', 'POST', { name: 'Mihomo stable profile', nodeFilter: { mode: 'all', sourceIds: [source.id] }, selectedGroupIds: [group.id], templates: { mihomo: tpl.id } })).data;
  assert.equal((await api(`/groups/${group.id}`, 'PUT', { name: 'Mihomo renamed exit' })).success, true);
  document.dns.nameserver.unshift('https://unrelated.identity.example/query#DIRECT');
  const content = JSON.stringify(document);
  assert.equal((await api(`/templates/${tpl.id}`, 'PUT', { content })).success, true);
  await stopApp(); await startApp();
  const response = await fetch(`${origin}/s/${profile.token}/mihomo?expand=true`);
  assert.equal(response.status, 200);
  const emitted = yaml.load(await response.text()) as any;
  assert.deepEqual(emitted.dns.nameserver, ['https://unrelated.identity.example/query#DIRECT', 'https://mihomo.identity.example/query#Mihomo%20renamed%20exit']);
  assert.equal((await api('/templates')).data.find((entry: any) => entry.id === tpl.id).content, content);
});

test('a reserved managed node name receives an unambiguous emitted tag', async () => {
  const source = (await api('/sources')).data.find((entry: any) => entry.name === 'Replacement source');
  const node = source.nodes[0];
  assert.equal((await api(`/nodes/${node.id}`, 'PUT', { name: 'GLOBAL' })).success, true);
  const group = (await api('/groups', 'POST', { name: 'Reserved node picker', type: 'select', proxies: [`node:${node.id}`] })).data;
  const tpl = (await api('/templates', 'POST', { name: 'Reserved namespace template', type: 'singbox', content: '{}' })).data;
  const profile = (await api('/profiles', 'POST', { name: 'Reserved namespace profile', nodeFilter: { mode: 'all', sourceIds: [source.id] }, selectedGroupIds: [group.id], templates: { singbox: tpl.id } })).data;
  const response = await fetch(`${origin}/s/${profile.token}/singbox`);
  assert.equal(response.status, 200);
  const doc = await response.json() as any;
  assert.equal(doc.outbounds.find((entry: any) => entry.tag === 'GLOBAL').type, 'selector');
  assert.equal(doc.outbounds.find((entry: any) => entry.server === '192.0.2.20').tag, 'GLOBAL (2)');
  assert.deepEqual(doc.outbounds.find((entry: any) => entry.tag === 'Reserved node picker').outbounds, ['GLOBAL (2)']);
});
