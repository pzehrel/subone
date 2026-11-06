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
const bodies = new Map<string, string>();
const upstream = createServer((request, response) => response.end(bodies.get(request.url || '/') || 'proxies: []'));
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
  const profile = (await api('/profiles', 'POST', { name: 'Pinned profile', nodeFilter: { mode: 'all', selectedNodeIds: [alpha.id, beta.id] }, selectedGroupIds: [group.data.id] })).data;
  await api(`/nodes/${alpha.id}`, 'PUT', { name: 'My alpha' });
  bodies.set('/references', clash([ss('Beta upstream', 'beta.example'), ss('Alpha upstream', 'alpha.example')]));
  await api(`/sources/${created.id}/refresh`, 'POST', {});
  await stopApp(); await startApp();
  const output = await fetch(`${origin}/s/${profile.token}/mihomo?expand=true`).then(response => response.text());
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
  assert.equal((await api('/nodes')).data.some((n: any) => n.id === stopped.id), false);
  for (const target of ['mihomo', 'singbox', 'loon', 'quantumultx', 'egern', 'shadowrocket']) {
    const preview = await api('/generate/preview', 'POST', { profileId: profile.id, customType: target, expandNodes: true });
    assert.equal(preview.success, true, preview.message);
    assert.equal(preview.data.includes('stopped.example'), false, target);
    const actual = await fetch(`${origin}/s/${profile.token}/${target}?expand=true`).then(response => response.text());
    assert.equal(actual.includes('stopped.example'), false, target);
    const provider = await fetch(`${origin}/s/${profile.token}/source/${created.id}/${target}`).then(response => response.text());
    assert.equal(provider.includes('stopped.example'), false, `${target} provider`);
  }
  const savedNodes = (await source(created.id)).nodes;
  await api(`/sources/${created.id}`, 'PUT', { enabled: false });
  assert.deepEqual((await source(created.id)).nodes, savedNodes);
  assert.equal((await api('/nodes')).data.some((n: any) => n.sourceId === created.id), false);
  assert.equal((await api('/generate/preview', 'POST', { profileId: profile.id, customType: 'mihomo', expandNodes: true })).nodeCount, 0);
  assert.equal((await fetch(`${origin}/s/${profile.token}/source/${created.id}/mihomo`)).status, 404);
  await api(`/sources/${created.id}`, 'PUT', { enabled: true });
  assert.deepEqual((await source(created.id)).nodes, savedNodes);
});
