import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

let directory: string;
let child: ChildProcess;
let origin: string;
let upstreamOrigin: string;
let body = '';
let status = 200;
const responses = new Map<string, { status: number; body: string; truncated?: boolean }>();
const upstream = createServer((request, response) => {
  const selected = responses.get(request.url || '');
  response.writeHead(selected?.status ?? status, { 'Subscription-Userinfo': 'upload=10; download=20; total=100', 'Content-Type': 'text/yaml; charset=utf-8', ...(selected?.truncated ? { 'Content-Length': '100000' } : {}) });
  if (selected?.truncated) {
    response.write(selected.body);
    setImmediate(() => response.destroy());
  } else response.end(selected?.body ?? body);
});

async function startApp() {
  child = spawn(process.execPath, ['--import', 'tsx', join(__dirname, 'helpers/http-server.ts')], {
    env: { ...process.env, SUBONE_ROOT: directory }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let errors = '';
  child.stderr?.on('data', chunk => { errors += chunk; });
  const message = await Promise.race([
    once(child, 'message'),
    once(child, 'exit').then(([code]) => { throw new Error(`Server exited ${code}: ${errors}`); }),
  ]);
  origin = `http://127.0.0.1:${message[0].port}`;
}
async function stopApp() {
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await exited;
}
async function api(path: string, method = 'GET', value?: unknown) {
  const response = await fetch(`${origin}/api${path}`, {
    method, headers: { 'Content-Type': 'application/json' },
    body: value === undefined ? undefined : JSON.stringify(value),
  });
  return { status: response.status, ...(await response.json() as any) };
}
const valid = '# upstream evidence\nproxies:\n  - { name: First, type: ss, server: one.example, port: 443, cipher: aes-128-gcm, password: secret }\ndns:\n  nameserver: [https://dns.example/dns-query, tls://ordinary.example]\ncustom: preserved\n';
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'subone-source-http-'));
  await writeFile(join(directory, 'config.json'), JSON.stringify({ port: 3456, adminPassword: '' }));
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const address = upstream.address();
  assert.ok(address && typeof address !== 'string');
  upstreamOrigin = `http://127.0.0.1:${address.port}`;
  await startApp();
});
after(async () => {
  await stopApp();
  await new Promise<void>(resolve => upstream.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
});

test('pasted upstream retains its exact content, parsed DoH and source identity after restart', async () => {
  const added = await api('/sources', 'POST', { name: '手动', acquisition: 'manual', content: valid, createGroup: true });
  assert.equal(added.status, 200, added.message);
  assert.equal(added.data.acquisition, 'manual');
  assert.equal(added.data.url, undefined);
  assert.equal(added.data.detectedFormat, 'mihomo');
  assert.equal(added.data.nodes.length, 1);
  assert.equal(added.data.doh.services.length, 1);
  assert.equal((await api(`/sources/${added.data.id}/raw`)).data.content, valid);
  await stopApp(); await startApp();
  assert.deepEqual((await api('/sources')).data[0], added.data);
});

async function source(id: string) { return (await api('/sources')).data.find((item: any) => item.id === id); }
async function add(content = valid, extra = {}) {
  const result = await api('/sources', 'POST', { name: 'Manual', acquisition: 'manual', content, ...extra });
  assert.equal(result.success, true, result.message);
  return result.data;
}

test('manual replacement preserves unique connections and local settings, cleans removals and isolates other sources', async () => {
  const content = 'proxies:\n - {name: Alpha, type: ss, server: alpha.example, port: 443, cipher: none}\n - {name: Beta, type: ss, server: beta.example, port: 443, cipher: none}\n';
  const initial = await add(content);
  const alpha = initial.nodes[0], beta = initial.nodes[1];
  await api(`/nodes/${alpha.id}`, 'PUT', { name: 'Local alpha', enabled: false });
  const other = await add(content);
  assert.notEqual(other.nodes[0].id, alpha.id);
  assert.equal(other.nodes[0].enabled, true);
  const group = (await api('/groups', 'POST', { name: 'Manual selection', type: 'select', proxies: [`node:${alpha.id}`, `node:${beta.id}`], sources: [initial.id] })).data;
  const replacement = 'proxies:\n - {name: Beta renamed, type: ss, server: beta.example, port: 443, cipher: none}\n - {name: Alpha renamed, type: ss, server: alpha.example, port: 443, cipher: none}\n';
  const updated = await api(`/sources/${initial.id}`, 'PUT', { name: 'Renamed manual', content: replacement });
  assert.equal(updated.success, true, updated.message);
  assert.deepEqual(updated.data.nodes.map((node: any) => node.id), [beta.id, alpha.id]);
  assert.equal(updated.data.nodes[1].name, 'Local alpha');
  assert.equal(updated.data.nodes[1].enabled, false);
  await stopApp(); await startApp();
  assert.deepEqual((await source(initial.id)).nodes, updated.data.nodes);
  const changed = await api(`/sources/${initial.id}`, 'PUT', { content: replacement.replace('beta.example', 'changed.example') });
  assert.notEqual(changed.data.nodes[0].id, beta.id);
  const config = (await api('/config')).data;
  assert.equal(config.proxyGroups.find((item: any) => item.id === group.id).proxies.includes(`node:${beta.id}`), false);
  const duplicate = await api(`/sources/${initial.id}`, 'PUT', { content: 'proxies:\n - {name: A, type: ss, server: alpha.example, port: 443, cipher: none}\n - {name: B, type: ss, server: alpha.example, port: 443, cipher: none}\n' });
  assert.equal(duplicate.data.nodes.every((node: any) => node.id !== alpha.id && node.enabled && !node.localName), true);
});

test('failed first paste leaves no objects; failed replacement preserves effective batch and records exact diagnostic raw', async () => {
  const before = (await api('/config')).data;
  const invalid = ['', ' \n', 'unknown', 'proxies: [', valid.replace('port: 443', 'port: 70000'), valid.replace('https://dns.example/dns-query', 'https://')];
  for (const content of invalid) {
    const result = await api('/sources', 'POST', { acquisition: 'manual', content, name: 'Rejected', createGroup: true });
    assert.equal(result.status, 422, content);
    assert.deepEqual((await api('/config')).data.sources, before.sources);
    assert.deepEqual((await api('/config')).data.proxyGroups, before.proxyGroups);
  }
  const initial = await add();
  const invalidDoh = valid.replace('https://dns.example/dns-query', 'https://');
  assert.equal((await api(`/sources/${initial.id}`, 'PUT', { content: invalidDoh })).status, 422);
  assert.deepEqual((await source(initial.id)).doh, initial.doh);
  assert.deepEqual((await source(initial.id)).nodes, initial.nodes);
  const incomplete = valid + 'proxies2: preserved\n';
  const broken = incomplete.replace('password: secret', 'password: ""');
  assert.equal((await api(`/sources/${initial.id}`, 'PUT', { content: broken, name: 'Should not apply' })).status, 422);
  const current = await source(initial.id);
  for (const field of ['name', 'nodes', 'doh', 'lastUpdated', 'parsedConfig']) assert.deepEqual(current[field], initial[field], field);
  const raw = (await api(`/sources/${initial.id}/raw`)).data;
  assert.equal(raw.content, broken);
  assert.equal(raw.parseStatus, 'failed');
  assert.equal(raw.lastSuccessfulUpdate, initial.lastUpdated);
  await stopApp(); await startApp();
  assert.deepEqual((await api(`/sources/${initial.id}/raw`)).data, raw);
  assert.equal((await api(`/sources/${initial.id}`, 'PUT', { content: 4 })).status, 400);
  assert.deepEqual((await api(`/sources/${initial.id}/raw`)).data, raw);
  const empty = await api(`/sources/${initial.id}`, 'PUT', { content: 'proxies: []\n' });
  assert.equal(empty.success, true);
  assert.deepEqual(empty.data.nodes, []);
  assert.equal(empty.data.doh.services.length, 0);
});

test('manual input uses UTF-8 byte limits inclusively without replacing the last raw on rejected input', async () => {
  const missing = await api('/sources', 'POST', { acquisition: 'manual' });
  assert.equal(missing.status, 400);
  const prefix = 'proxies: []\n#';
  const exact = prefix + '中'.repeat(349520) + 'xxx'; // 13 + 1,048,560 + 3 = 1,048,576 bytes
  assert.equal(Buffer.byteLength(exact), 1_048_576);
  const initial = await add(exact);
  assert.equal((await api(`/sources/${initial.id}/raw`)).data.content, exact);
  for (const content of [exact + 'x', prefix + '中'.repeat(349522)]) {
    assert.equal((await api('/sources', 'POST', { acquisition: 'manual', content })).status, 400);
    assert.equal((await api(`/sources/${initial.id}`, 'PUT', { content })).status, 400);
    assert.equal((await api(`/sources/${initial.id}/raw`)).data.content, exact);
  }
});

test('paste supports existing complete formats and Base64 encoding while preserving original text', async () => {
  const samples = [
    ['mihomo', '\uFEFF' + valid],
    ['singbox', '{"outbounds":[{"type":"socks","tag":"JSON","server":"json.example","server_port":1080}]}'],
    ['quantumultx', '[server_local]\nshadowsocks=qx.example:443, method=aes-128-gcm, password=secret, tag=QX'],
    ['uri', 'ss://YWVzLTEyOC1nY206c2VjcmV0@uri.example:443#URI'],
  ];
  for (const [format, content] of samples) {
    const initial = await add(content);
    assert.equal(initial.detectedFormat, format);
    assert.equal(initial.nodes.length, 1);
    assert.equal((await api(`/sources/${initial.id}/raw`)).data.content, content);
    const encoded = ' ' + Buffer.from(content).toString('base64') + '\n';
    const result = await api(`/sources/${initial.id}`, 'PUT', { content: encoded });
    assert.equal(result.success, true, result.message);
    const raw = (await api(`/sources/${initial.id}/raw`)).data;
    assert.equal(raw.encoding, 'base64');
    assert.equal(raw.format, format === 'uri' ? 'base64' : format);
    assert.equal(raw.content, encoded);
  }
});

test('settings-only edits classify information nodes without new content and validate matching rules', async () => {
  const initial = await add('proxies:\n - {name: "Traffic used 1 GB / 10 GB", type: ss, server: info.example, port: 443, cipher: none}\n - {name: "Expiry 2030-01-01", type: ss, server: expiry.example, port: 443, cipher: none}\n - {name: Proxy, type: ss, server: proxy.example, port: 443, cipher: none}\n');
  const updated = await api(`/sources/${initial.id}`, 'PUT', { name: 'Settings', enabled: false, trafficNodeRegex: 'traffic', expiryNodeRegex: 'expiry' });
  assert.equal(updated.success, true);
  assert.equal(updated.data.nodeCount, 1);
  assert.equal(updated.data.infoNodes.length, 2);
  assert.equal(updated.data.enabled, false);
  assert.equal(updated.data.lastUpdated, initial.lastUpdated);
  assert.deepEqual(updated.data.rawSubscription, initial.rawSubscription);
  assert.equal((await api(`/sources/${initial.id}`, 'PUT', { trafficNodeRegex: '[' })).status, 400);
  await stopApp(); await startApp();
  assert.deepEqual(await source(initial.id), updated.data);
});

test('mixed update-all skips manual sources, while direct update instructs the user to supply content', async () => {
  const initial = await add();
  body = 'proxies: []';
  const remote = await api('/sources', 'POST', { url: upstreamOrigin, name: 'Address' });
  const before = await source(initial.id);
  const result = await api('/sources/refresh-all', 'POST', {});
  assert.equal(result.success, true);
  assert.equal(result.results.some((item: any) => item.sourceId === initial.id), false);
  assert.equal(result.results.find((item: any) => item.sourceId === remote.data.id).success, true);
  assert.deepEqual(await source(initial.id), before);
  const direct = await api(`/sources/${initial.id}/refresh`, 'POST', {});
  assert.equal(direct.status, 400);
  assert.match(direct.message, /粘贴/);
  assert.deepEqual(await source(initial.id), before);
});

test('storage failure publishes no manual candidate or failed raw, including after restart', async () => {
  const initial = await add();
  const before = (await api('/config')).data;
  await chmod(join(directory, 'data'), 0o500);
  try {
    assert.equal((await api('/sources', 'POST', { acquisition: 'manual', content: valid, name: 'Unsaved', createGroup: true })).status, 500);
    assert.equal((await api(`/sources/${initial.id}`, 'PUT', { content: valid.replace('one.example', 'unsaved.example') })).status, 500);
    assert.equal((await api(`/sources/${initial.id}`, 'PUT', { content: 'unknown' })).status, 500);
    assert.deepEqual((await api('/config')).data.sources, before.sources);
    assert.deepEqual((await api('/config')).data.proxyGroups, before.proxyGroups);
  } finally { await chmod(join(directory, 'data'), 0o700); }
  await stopApp(); await startApp();
  assert.deepEqual((await api('/config')).data.sources, before.sources);
});

test('manual sources generate representative downstream nodes and DoH, respect local settings and remove source references on deletion', async () => {
  const initial = await add(valid.replace('custom: preserved', ''));
  const node = initial.nodes[0];
  await api(`/nodes/${node.id}`, 'PUT', { name: 'Local downstream' });
  const group = (await api('/groups', 'POST', { name: 'Manual group', type: 'select', sources: [initial.id] })).data;
  const template = (await api('/templates', 'POST', { name: 'Manual template', type: 'mihomo', content: 'proxies: []\nproxy-groups: []\ndns:\n  enable: true\n  nameserver: [https://template.example/dns-query]\n  default-nameserver: [1.1.1.1]\n  proxy-server-nameserver: [1.1.1.1]\nrules: ["MATCH,DIRECT"]\n' })).data;
  const profile = (await api('/profiles', 'POST', { name: 'Manual profile', nodeFilter: { mode: 'all', sourceIds: [initial.id] }, selectedGroupIds: [group.id], templates: { mihomo: template.id } })).data;
  const preview = await api('/generate/preview', 'POST', { profileId: profile.id, customType: 'mihomo', expandNodes: true });
  assert.equal(preview.success, true, JSON.stringify(preview.generation));
  assert.match(preview.data, /Local downstream/);
  assert.match(preview.data, /dns.example\/dns-query/);
  assert.match(preview.data, /one.example/);
  await stopApp(); await startApp();
  const output = await fetch(`${origin}/s/${profile.token}/mihomo?expand=true`).then(response => response.text());
  assert.match(output, /Local downstream/);
  assert.match(output, /dns.example\/dns-query/);
  await api(`/nodes/${node.id}`, 'PUT', { enabled: false });
  const disabled = await api('/generate/preview', 'POST', { profileId: profile.id, customType: 'mihomo', expandNodes: true });
  assert.doesNotMatch(disabled.data, /server: one.example/);
  assert.equal((await api(`/sources/${initial.id}`, 'DELETE')).success, true);
  const config = (await api('/config')).data;
  assert.equal(config.sources.some((item: any) => item.id === initial.id), false);
  assert.equal(config.proxyGroups.some((item: any) => item.sources?.includes(initial.id)), false);
  assert.equal(config.profiles.find((item: any) => item.id === profile.id).nodeFilter.sourceIds.includes(initial.id), false);
});
