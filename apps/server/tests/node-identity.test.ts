import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import yaml from 'js-yaml';

let directory: string;
let child: ChildProcess;
let origin: string;
let upstreamOrigin: string;
const bodies = new Map<string, string>();
let holdPath: string | undefined;
let onHeld: (() => void) | undefined;
let releaseResponse: (() => void) | undefined;
const upstream = createServer((request, response) => {
  const send = () => response.end(bodies.get(request.url || '/') || 'proxies: []');
  if (request.url === holdPath) { holdPath = undefined; releaseResponse = send; onHeld?.(); }
  else send();
});
async function startApp() {
  child = spawn(process.execPath, ['--import', 'tsx', join(__dirname, 'helpers/http-server.ts')], { env: { ...process.env, SUBONE_ROOT: directory }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let errors = '';
  child.stderr?.on('data', chunk => { errors += chunk; });
  const message = await Promise.race([once(child, 'message'), once(child, 'exit').then(([code]) => { throw new Error(`Server exited ${code}: ${errors}`); })]);
  origin = `http://127.0.0.1:${message[0].port}`;
}
async function stopApp() { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; }
async function api(path: string, method = 'GET', value?: unknown) {
  const response = await fetch(`${origin}/api${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: value === undefined ? undefined : JSON.stringify(value) });
  return { status: response.status, ...await response.json() as any };
}
function clash(entries: Record<string, unknown>[]) { return yaml.dump({ proxies: entries }); }
const ss = (name: string, server = 'one.example', extra: Record<string, unknown> = {}) => ({ name, type: 'ss', server, port: 443, cipher: 'aes-128-gcm', password: 'secret', ...extra });
async function add(path: string, content: string) {
  bodies.set(path, content);
  const result = await api('/sources', 'POST', { name: path.slice(1), url: upstreamOrigin + path });
  assert.equal(result.success, true, result.message);
  return result.data;
}
async function source(id: string) { return (await api('/sources')).data.find((s: any) => s.id === id); }
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'subone-identity-http-'));
  await writeFile(join(directory, 'config.json'), JSON.stringify({ port: 3456, adminPassword: '' }));
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const address = upstream.address(); assert.ok(address && typeof address !== 'string');
  upstreamOrigin = `http://127.0.0.1:${address.port}`;
  await startApp();
});
after(async () => { await stopApp(); await new Promise<void>(resolve => upstream.close(() => resolve())); await rm(directory, { recursive: true, force: true }); });

test('upstream rename and reorder preserve unique connection identities and local settings through restart', async () => {
  const initial = await add('/stable', clash([ss('First'), ss('Second', 'two.example')]));
  const first = initial.nodes[0]; const second = initial.nodes[1];
  assert.equal((await api(`/nodes/${first.id}`, 'PUT', { name: 'My node', enabled: false })).success, true);
  bodies.set('/stable', clash([ss('Second renamed', 'two.example'), ss('First renamed')]));
  assert.equal((await api(`/sources/${initial.id}/refresh`, 'POST', {})).success, true);
  const updated = await source(initial.id);
  assert.deepEqual(updated.nodes.map((n: any) => n.id), [second.id, first.id]);
  assert.equal(updated.nodes[0].name, 'Second renamed');
  assert.equal(updated.nodes[1].name, 'My node');
  assert.equal(updated.nodes[1].originalName, 'First renamed');
  assert.equal(updated.nodes[1].enabled, false);
  await stopApp(); await startApp();
  assert.deepEqual((await source(initial.id)).nodes, updated.nodes);
  assert.equal((await api(`/nodes/${first.id}`, 'PUT', { name: null, enabled: true })).data.name, 'First renamed');
});

test('complete raw changes and ambiguous duplicates receive fresh settings while source identity stays isolated', async () => {
  const initial = await add('/raw', clash([ss('Original', 'raw.example', { 'plugin-opts': { nested: { name: 'transport', tag: 'connection' }, enabled: false } })]));
  const original = initial.nodes[0];
  await api(`/nodes/${original.id}`, 'PUT', { name: 'Local', enabled: false });
  const other = await add('/isolated', clash([ss('Original', 'raw.example', { 'plugin-opts': { nested: { name: 'transport', tag: 'connection' }, enabled: false } })]));
  assert.notEqual(other.nodes[0].id, original.id);
  bodies.set('/raw', clash([ss('Renamed', 'raw.example', { 'plugin-opts': { enabled: false, nested: { tag: 'connection', name: 'transport' } } })]));
  await api(`/sources/${initial.id}/refresh`, 'POST', {});
  assert.equal((await source(initial.id)).nodes[0].id, original.id);
  bodies.set('/raw', clash([ss('Renamed', 'raw.example', { 'plugin-opts': { enabled: false, nested: { tag: 'changed', name: 'transport' } } })]));
  await api(`/sources/${initial.id}/refresh`, 'POST', {});
  const changed = (await source(initial.id)).nodes[0];
  assert.notEqual(changed.id, original.id);
  assert.equal(changed.enabled, true);
  assert.equal(changed.name, 'Renamed');
  await api(`/nodes/${changed.id}`, 'PUT', { name: 'Do not inherit', enabled: false });
  bodies.set('/raw', clash([ss('Duplicate A', 'raw.example', { 'plugin-opts': { enabled: false, nested: { tag: 'changed', name: 'transport' } } }), ss('Duplicate B', 'raw.example', { 'plugin-opts': { enabled: false, nested: { tag: 'changed', name: 'transport' } } })]));
  await api(`/sources/${initial.id}/refresh`, 'POST', {});
  const duplicate = await source(initial.id);
  assert.equal(duplicate.nodes.every((n: any) => n.id !== changed.id && n.enabled && !n.localName), true);
  assert.notEqual(duplicate.nodes[0].id, duplicate.nodes[1].id);
  bodies.set('/raw', clash([ss('Unique again', 'raw.example', { 'plugin-opts': { enabled: false, nested: { tag: 'changed', name: 'transport' } } })]));
  await api(`/sources/${initial.id}/refresh`, 'POST', {});
  assert.equal(duplicate.nodes.some((n: any) => n.id === undefined), false);
  const uniqueAgain = (await source(initial.id)).nodes[0];
  assert.equal(duplicate.nodes.some((n: any) => n.id === uniqueAgain.id), false);
});

test('information matching follows original upstream names while local settings survive cached reclassification', async () => {
  const created = await add('/information', clash([ss('Traffic used 1 GB / 10 GB', 'info.example'), ss('Proxy', 'proxy.example')]));
  const notice = created.nodes[0];
  await api(`/nodes/${notice.id}`, 'PUT', { name: 'My label', enabled: false });
  const classified = await api(`/sources/${created.id}`, 'PUT', { trafficNodeRegex: '^Traffic' });
  assert.equal(classified.data.nodeCount, 1);
  assert.equal(classified.data.infoNodes[0].id, notice.id);
  assert.equal(classified.data.infoNodes[0].name, 'My label');
  assert.equal(classified.data.infoNodes[0].enabled, false);
  const cleared = await api(`/sources/${created.id}`, 'PUT', { trafficNodeRegex: '' });
  assert.equal(cleared.data.nodes.find((n: any) => n.id === notice.id).name, 'My label');
});

test('stable profile and explicit group references follow local and upstream renames in client output', async () => {
  const created = await add('/references', clash([ss('Alpha', 'alpha.example'), ss('Beta', 'beta.example')]));
  const alpha = created.nodes[0]; const beta = created.nodes[1];
  const group = await api('/groups', 'POST', { name: 'Pinned members', type: 'select', proxies: ['Alpha', 'Beta'] });
  assert.equal(group.success, true);
  assert.deepEqual(group.data.proxies, [`node:${alpha.id}`, `node:${beta.id}`]);
  const template = (await api('/templates', 'POST', { name: 'Pinned identity', type: 'mihomo', content: yaml.dump({ proxies: [], 'proxy-groups': [], rules: ['MATCH,Pinned members'] }) })).data;
  const profile = (await api('/profiles', 'POST', { name: 'Pinned profile', nodeFilter: { mode: 'all', selectedNodeIds: [alpha.id, beta.id] }, selectedGroupIds: [group.data.id], templates: { mihomo: template.id } })).data;
  await api(`/nodes/${alpha.id}`, 'PUT', { name: 'My alpha' });
  bodies.set('/references', clash([ss('Beta upstream', 'beta.example'), ss('Alpha upstream', 'alpha.example')]));
  await api(`/sources/${created.id}/refresh`, 'POST', {});
  await stopApp(); await startApp();
  const output = await fetch(`${origin}/s/${profile.token}/mihomo`).then(response => response.text());
  const config = yaml.load(output) as any;
  assert.deepEqual(config.proxies.map((p: any) => p.name).sort(), ['Beta upstream', 'My alpha']);
  assert.deepEqual(config['proxy-groups'].find((g: any) => g.name === 'Pinned members').proxies, ['My alpha', 'Beta upstream']);
});

test('disabled nodes and sources are excluded from every effective, preview, private and provider output', async () => {
  const created = await add('/disable', clash([ss('Available', 'available.example'), ss('Stopped', 'stopped.example')]));
  const stopped = created.nodes[1];
  await api(`/nodes/${stopped.id}`, 'PUT', { enabled: false, name: 'Keep setting' });
  const group = (await api('/groups', 'POST', { name: 'Disabled candidates', type: 'select', sources: [created.id], proxies: [`node:${stopped.id}`] })).data;
  const profile = (await api('/profiles', 'POST', { name: 'Disable profile', nodeFilter: { mode: 'all', sourceIds: [created.id] }, selectedGroupIds: [group.id] })).data;
  const nativeRule = (await api('/rules/unified', 'POST', { name: 'Node isolation rule', kind: 'local', type: 'DOMAIN', payload: 'isolation.example', outbound: 'DIRECT', enabled: true })).data;
  const templates: Record<string, string> = {};
  for (const [type, content] of Object.entries({
    singbox: JSON.stringify({ outbounds: [{ type: 'direct', tag: 'DIRECT' }], route: { final: 'DIRECT' } }),
    mihomo: 'proxies: []\nproxy-groups: []\nrules: ["MATCH,DIRECT"]\n',
    loon: '[General]\ndns-server = system\n[Proxy]\n[Proxy Group]\n[Rule]\nFINAL,DIRECT\n',
    quantumultx: '[general]\n[dns]\n[server_local]\n[policy]\n[filter_local]\nfinal,direct\n',
    egern: 'proxies: []\npolicy_groups: []\nrules:\n  - default: {policy: DIRECT}\n',
    shadowrocket: '[General]\ndns-server = system\n[Proxy]\n[Proxy Group]\n[Rule]\nFINAL,DIRECT\n',
  })) templates[type] = (await api('/templates', 'POST', { name: `Disabled identity ${type}`, type, content })).data.id;
  await api(`/profiles/${profile.id}`, 'PUT', { selectedRuleIds: [nativeRule.id], templates });
  assert.equal((await api('/nodes')).data.some((n: any) => n.id === stopped.id), false);
  for (const target of ['mihomo', 'singbox', 'loon', 'quantumultx', 'egern', 'shadowrocket']) {
    const preview = await api('/generate/preview', 'POST', { profileId: profile.id, customType: target, expandNodes: true });
    if (target === 'shadowrocket') {
      // Full native groups retain disabled explicit members as repair intent; URI providers carry only ordinary entries.
      assert.equal(preview.status, 422);
      assert.ok(preview.generation.diagnostics.some((entry: any) => entry.code === 'shadowrocket-outbound-reference-missing'));
      assert.equal((await fetch(`${origin}/s/${profile.token}/${target}?expand=true`)).status, 422);
      const provider = await fetch(`${origin}/s/${profile.token}/source/${created.id}/${target}`);
      assert.equal(provider.status, 200);
      assert.equal(Buffer.from(await provider.text(), 'base64').toString().includes('stopped.example'), false);
      continue;
    }
    if (target === 'egern' || target === 'quantumultx') {
      // Native adapters retain explicit unavailable required members as repair intent.
      assert.equal(preview.status, 422);
      assert.ok(preview.generation.diagnostics.some((entry: any) => entry.code === (target === 'egern' ? 'egern-reference-missing' : 'quantumultx-reference-missing')));
      assert.equal((await fetch(`${origin}/s/${profile.token}/${target}?expand=true`)).status, 422);
      const provider = await fetch(`${origin}/s/${profile.token}/source/${created.id}/${target}`);
      assert.equal(provider.status, 200);
      assert.equal((await provider.text()).includes('stopped.example'), false);
      continue;
    }
    assert.equal(preview.status, 422, JSON.stringify(preview));
    assert.ok(preview.generation.diagnostics.some((entry: any) => entry.severity === 'error'));
    assert.equal(preview.generation.dependencyNodeCount, 0);
    const actual = await fetch(`${origin}/s/${profile.token}/${target}?expand=true`); assert.equal(actual.status, 422);
    const provider = await fetch(`${origin}/s/${profile.token}/source/${created.id}/${target}`);
    assert.equal(provider.status, 200);
    assert.equal((await provider.text()).includes('stopped.example'), false, `${target} provider`);
  }
  const savedNodes = (await source(created.id)).nodes;
  await api(`/sources/${created.id}`, 'PUT', { enabled: false });
  assert.deepEqual((await source(created.id)).nodes, savedNodes);
  assert.equal((await api('/nodes')).data.some((n: any) => n.sourceId === created.id), false);
  const disabledSource = await api('/generate/preview', 'POST', { profileId: profile.id, customType: 'mihomo', expandNodes: true });
  assert.equal(disabledSource.status, 422); assert.equal(disabledSource.generation.nodeCount, 0);
  assert.equal((await fetch(`${origin}/s/${profile.token}/source/${created.id}/mihomo`)).status, 404);
  await api(`/sources/${created.id}`, 'PUT', { enabled: true });
  assert.deepEqual((await source(created.id)).nodes, savedNodes);
});

test('source removal clears owned records and stable selections without retargeting another source', async () => {
  const removed = await add('/delete-owned', clash([ss('Owned', 'owned.example')]));
  const survivor = await add('/delete-survivor', clash([ss('Owned', 'survivor.example')]));
  const node = removed.nodes[0];
  const group = (await api('/groups', 'POST', { name: 'Owned reference', type: 'select', proxies: [`node:${node.id}`], sources: [removed.id] })).data;
  const safe = (await api('/groups', 'POST', { name: 'Owned source isolation', type: 'select', proxies: ['DIRECT'] })).data;
  const template = (await api('/templates', 'POST', { name: 'Owned removal identity', type: 'mihomo', content: 'proxies: []\nproxy-groups: []\nrules: ["MATCH,DIRECT"]\n' })).data;
  const profile = (await api('/profiles', 'POST', { name: 'Owned selection', nodeFilter: { mode: 'all', selectedNodeIds: [node.id] }, selectedGroupIds: [group.id], templates: { mihomo: template.id } })).data;
  const sourceProfile = (await api('/profiles', 'POST', { name: 'Owned source selection', nodeFilter: { mode: 'all', sourceIds: [removed.id] }, selectedGroupIds: [safe.id], templates: { mihomo: template.id } })).data;
  await api(`/nodes/${node.id}`, 'PUT', { name: 'Owned local', enabled: false });
  const beforeRaw = (await api(`/sources/${removed.id}/raw`)).data;
  assert.equal((await api(`/nodes/${node.id}`, 'PUT', { server: 'mutated.example' })).status, 400);
  assert.deepEqual((await api(`/sources/${removed.id}/raw`)).data, beforeRaw);
  for (const [path, method, value] of [['/custom-nodes', 'POST', { name: 'Independent' }], ['/custom-nodes/import', 'POST', { text: 'ss://a' }], [`/nodes/${node.id}`, 'DELETE', undefined], [`/sources/${removed.id}/clear-nodes`, 'POST', {}]] as const) {
    assert.equal((await fetch(`${origin}/api${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: value === undefined ? undefined : JSON.stringify(value) })).status, 404);
  }
  assert.equal((await api(`/sources/${removed.id}`, 'DELETE')).success, true);
  assert.equal(await source(removed.id), undefined);
  assert.equal((await api(`/nodes/${node.id}`, 'PUT', { name: 'Gone' })).status, 404);
  const config = (await api('/config')).data;
  assert.equal(config.proxyGroups.find((g: any) => g.id === group.id).proxies.includes(`node:${node.id}`), false);
  assert.equal(config.profiles.find((p: any) => p.id === profile.id).nodeFilter.selectedNodeIds.includes(node.id), false);
  for (const selected of [profile, sourceProfile]) {
    const preview = await api('/generate/preview', 'POST', { profileId: selected.id, customType: 'mihomo', expandNodes: true });
    if (selected.id === profile.id) {
      assert.equal(preview.status, 422, JSON.stringify(preview));
      assert.equal(preview.generation.nodeCount, 0);
      assert.match(preview.generation.diagnostics.at(-1).message, /unresolved:Owned local/);
    } else {
      assert.equal(preview.success, true, JSON.stringify(preview));
      assert.equal(preview.nodeCount, 0);
      assert.equal(preview.data.includes('survivor.example'), false);
    }
  }
  await stopApp(); await startApp();
  assert.equal(await source(removed.id), undefined);
  assert.equal((await source(survivor.id)).nodes[0].name, 'Owned');
});

test('URI display changes never infer connection settings and canonical raw options preserve identity', async () => {
  const uri = 'vless://11111111-1111-4111-8111-111111111111@uri.example:443?security=tls&sni=uri.example&x-custom=a&x-custom=b';
  const created = await add('/uri', `${uri}#Basic`);
  const node = created.nodes[0];
  bodies.set('/uri', `${uri}#Vision%20XTLS`);
  await api(`/sources/${created.id}/refresh`, 'POST', {});
  const renamed = (await source(created.id)).nodes[0];
  assert.equal(renamed.id, node.id);
  assert.equal(renamed.flow, undefined);
  const encoded = (value: object) => `v2rayn://${Buffer.from(JSON.stringify(value)).toString('base64')}`;
  const payload = { Protocol: 'vless', Address: 'v2ray.example', Port: 443, Id: '11111111-1111-4111-8111-111111111111', Remarks: 'Basic', StreamSecurity: 'tls', Network: 'tcp', UnknownOption: { name: 'keep', tag: 'also keep' } };
  const jsonSource = await add('/v2ray', encoded(payload));
  bodies.set('/v2ray', encoded({ ...payload, Remarks: 'H2 vision xtls' }));
  await api(`/sources/${jsonSource.id}/refresh`, 'POST', {});
  const jsonRenamed = (await source(jsonSource.id)).nodes[0];
  assert.equal(jsonRenamed.id, jsonSource.nodes[0].id);
  assert.equal(jsonRenamed.flow, undefined);
  assert.equal(jsonRenamed.network, 'tcp');
  bodies.set('/v2ray', encoded({ ...payload, UnknownOption: { name: 'changed', tag: 'also keep' } }));
  await api(`/sources/${jsonSource.id}/refresh`, 'POST', {});
  assert.notEqual((await source(jsonSource.id)).nodes[0].id, jsonRenamed.id);
});

test('source-local node chains retain stable targets through upstream and local renames', async () => {
  const outbounds = (target: string, dependent: string) => JSON.stringify({ outbounds: [
    { type: 'shadowsocks', tag: target, server: 'entry.example', server_port: 443, method: 'aes-128-gcm', password: 'entry' },
    { type: 'shadowsocks', tag: dependent, server: 'exit.example', server_port: 443, method: 'aes-128-gcm', password: 'exit', detour: target },
  ] });
  const initial = await add('/chain', outbounds('Entry', 'Exit'));
  const entry = initial.nodes[0]; const exit = initial.nodes[1];
  await api(`/nodes/${entry.id}`, 'PUT', { name: 'My entry' });
  await api(`/nodes/${exit.id}`, 'PUT', { name: 'My exit' });
  bodies.set('/chain', outbounds('Entry upstream', 'Exit upstream'));
  await api(`/sources/${initial.id}/refresh`, 'POST', {});
  const updated = await source(initial.id);
  assert.deepEqual(updated.nodes.map((n: any) => n.id), [entry.id, exit.id]);
  assert.equal(updated.nodes[1].detourRef, `node:${entry.id}`);
  assert.equal(updated.nodes[1].raw.detour, 'Entry upstream');
  const safe = (await api('/groups', 'POST', { name: 'Chain identity isolation', type: 'select', proxies: ['DIRECT'] })).data;
  const profile = (await api('/profiles', 'POST', { name: 'Chain', nodeFilter: { mode: 'all', sourceIds: [initial.id] }, selectedGroupIds: [safe.id] })).data;
  const preview = await api('/generate/preview', 'POST', { profileId: profile.id, customType: 'singbox', customTemplate: '{"outbounds":[]}' });
  assert.equal(preview.success, true, JSON.stringify(preview));
  const generated = JSON.parse(preview.data);
  assert.equal(generated.outbounds.find((outbound: any) => outbound.tag === 'My exit').detour, 'My entry');
  assert.equal((await api(`/sources/${initial.id}/raw`)).data.content, outbounds('Entry upstream', 'Exit upstream'));
});

test('ambiguous labels reject group writes while explicit IDs keep collision-safe names consistent in providers', async () => {
  const a = await add('/collision-a', clash([ss('A=B', 'collision-a.example')]));
  const b = await add('/collision-b', clash([ss('A,B', 'collision-b.example')]));
  const duplicate = await add('/collision-copy', clash([ss('A=B', 'collision-copy.example')]));
  const rejected = await api('/groups', 'POST', { name: 'Ambiguous labels', type: 'select', proxies: ['A=B'] });
  assert.equal(rejected.status, 400);
  const group = (await api('/groups', 'POST', { name: 'A_B', type: 'select', proxies: [`node:${a.nodes[0].id}`, `node:${b.nodes[0].id}`, `node:${duplicate.nodes[0].id}`] })).data;
  const profile = (await api('/profiles', 'POST', { name: 'Collisions', nodeFilter: { mode: 'all', sourceIds: [a.id, b.id, duplicate.id] }, selectedGroupIds: [group.id] })).data;
  const preview = await api('/generate/preview', 'POST', { profileId: profile.id, customType: 'loon', expandNodes: true });
  assert.equal(preview.success, true);
  const members = preview.data.split('\n').find((line: string) => line.startsWith('A_B = select'));
  assert.ok(members, preview.data);
  for (const created of [a, b, duplicate]) {
    const provider = await fetch(`${origin}/s/${profile.token}/source/${created.id}/loon`).then(response => response.text());
    const emittedName = provider.split('\n').find(line => line.includes(created.nodes[0].server))!.split(' = ')[0];
    assert.ok(members.includes(emittedName), `${emittedName}: ${members}`);
    assert.ok(preview.data.includes(`${emittedName} = Shadowsocks,${created.nodes[0].server},`));
  }
});

test('successful upstream removal clears references and a returning connection starts with fresh local settings', async () => {
  const created = await add('/returning', clash([ss('Returning', 'returning.example')]));
  const old = created.nodes[0];
  await api(`/nodes/${old.id}`, 'PUT', { name: 'Old setting', enabled: false });
  const safe = (await api('/groups', 'POST', { name: 'Returning identity isolation', type: 'select', proxies: ['DIRECT'] })).data;
  const template = (await api('/templates', 'POST', { name: 'Returning identity', type: 'mihomo', content: 'proxies: []\nproxy-groups: []\nrules: ["MATCH,DIRECT"]\n' })).data;
  const profile = (await api('/profiles', 'POST', { name: 'Returning selected', nodeFilter: { selectedNodeIds: [old.id] }, selectedGroupIds: [safe.id], templates: { mihomo: template.id } })).data;
  bodies.set('/returning', 'proxies: []');
  await api(`/sources/${created.id}/refresh`, 'POST', {});
  assert.deepEqual((await source(created.id)).nodes, []);
  bodies.set('/returning', clash([ss('Returning', 'returning.example')]));
  await api(`/sources/${created.id}/refresh`, 'POST', {});
  const returned = (await source(created.id)).nodes[0];
  assert.notEqual(returned.id, old.id);
  assert.equal(returned.name, 'Returning');
  assert.equal(returned.enabled, true);
  assert.equal((await api('/generate/preview', 'POST', { profileId: profile.id, customType: 'mihomo', expandNodes: true })).nodeCount, 0);
});

test('QuanX labels and option order preserve identity while unknown or repeated connection options remain significant', async () => {
  const created = await add('/qx-identity', '[server_local]\nshadowsocks=qx.example:443, method=aes-128-gcm, password=secret, x-option=one, x-option=two, tag=First\n');
  const original = created.nodes[0];
  await api(`/nodes/${original.id}`, 'PUT', { name: 'Local QX' });
  bodies.set('/qx-identity', '[server_local]\nshadowsocks=qx.example:443, tag=Renamed, x-option=one, x-option=two, password=secret, method=aes-128-gcm\n');
  await api(`/sources/${created.id}/refresh`, 'POST', {});
  assert.equal((await source(created.id)).nodes[0].id, original.id);
  assert.equal((await source(created.id)).nodes[0].name, 'Local QX');
  bodies.set('/qx-identity', '[server_local]\nshadowsocks=qx.example:443, tag=Renamed, x-option=two, x-option=one, password=secret, method=aes-128-gcm\n');
  await api(`/sources/${created.id}/refresh`, 'POST', {});
  assert.notEqual((await source(created.id)).nodes[0].id, original.id);
});

test('a local rename and disable saved during an upstream fetch survives its successful commit', async () => {
  const created = await add('/concurrent', clash([ss('Before', 'concurrent.example')]));
  const node = created.nodes[0];
  const held = new Promise<void>(resolve => { onHeld = resolve; });
  holdPath = '/concurrent';
  const refreshing = api(`/sources/${created.id}/refresh`, 'POST', {});
  await held;
  try {
    assert.equal((await api(`/nodes/${node.id}`, 'PUT', { name: 'Saved during fetch', enabled: false })).success, true);
    bodies.set('/concurrent', clash([ss('After upstream', 'concurrent.example')]));
  } finally { releaseResponse?.(); }
  assert.equal((await refreshing).success, true);
  const updated = (await source(created.id)).nodes[0];
  assert.equal(updated.id, node.id);
  assert.equal(updated.name, 'Saved during fetch');
  assert.equal(updated.originalName, 'After upstream');
  assert.equal(updated.enabled, false);
});

test('failed local setting and source deletion saves publish no partial mutation', async () => {
  const created = await add('/save-failure', clash([ss('Saved', 'save.example')]));
  const node = created.nodes[0];
  const before = (await api('/config')).data;
  await chmod(join(directory, 'data'), 0o500);
  try {
    const local = await api(`/nodes/${node.id}`, 'PUT', { name: 'Unsaved', enabled: false });
    assert.equal(local.status, 500);
    assert.deepEqual((await api('/config')).data, before);
    const deleted = await api(`/sources/${created.id}`, 'DELETE');
    assert.equal(deleted.status, 500);
    assert.deepEqual((await api('/config')).data, before);
  } finally { await chmod(join(directory, 'data'), 0o700); }
  await stopApp(); await startApp();
  assert.deepEqual((await api('/config')).data, before);
});

test('YAML group imports bind node and source labels once and preserve unavailable references on reads and edits', async () => {
  const created = await add('/yaml-group', clash([ss('YAML member', 'yaml-group.example')]));
  const imported = await api('/groups/batch-import', 'POST', { text: yaml.dump({ 'proxy-groups': [{ name: 'YAML group', type: 'select', proxies: ['YAML member'], use: [created.name, 'missing-source-id'] }] }) });
  assert.equal(imported.success, true);
  const group = imported.data.find((g: any) => g.name === 'YAML group');
  assert.deepEqual(group.proxies, [`node:${created.nodes[0].id}`]);
  assert.deepEqual(group.sources, [created.id, 'missing-source-id']);
  await api(`/nodes/${created.nodes[0].id}`, 'PUT', { name: 'Renamed YAML member' });
  const listed = (await api('/groups')).data.find((g: any) => g.id === group.id);
  assert.deepEqual(listed.sources, [created.id, 'missing-source-id']);
  const edited = await api(`/groups/${group.id}`, 'PUT', { ...listed, name: 'Edited YAML group' });
  assert.deepEqual(edited.data.sources, [created.id, 'missing-source-id']);
  assert.deepEqual(edited.data.proxies, [`node:${created.nodes[0].id}`]);
});
