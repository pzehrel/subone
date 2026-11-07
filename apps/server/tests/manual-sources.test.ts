import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
const requests: string[] = [];
const upstream = createServer((request, response) => {
  requests.push(request.url || '');
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
  await mkdir(join(directory, 'data'));
  await writeFile(join(directory, 'data', 'config.json'), JSON.stringify({ sources: [{ id: 'legacy-switch', name: 'Legacy address', url: upstreamOrigin + '/legacy-switch', type: 'manual', enabled: true }] }));
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
  assert.deepEqual(await source(added.data.id), added.data);
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

test('file sources generate representative downstream nodes and DoH, respect local settings and remove source references on deletion', async () => {
  const result = await api('/sources', 'POST', { acquisition: 'manual', name: 'File downstream', ...fileInput(valid.replace('custom: preserved', '')) });
  assert.equal(result.status, 200, result.message);
  const initial = result.data;
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

function fileInput(content: string | Buffer, name = 'subscription.json') {
  return { contentFile: { name, base64: Buffer.from(content).toString('base64') } };
}

test('file upload preserves BOM and exact raw, matches paste, replaces the same source and survives restart', async () => {
  const content = '\uFEFF' + valid;
  const pasted = await add(content);
  const result = await api('/sources', 'POST', { acquisition: 'manual', name: 'File', ...fileInput(content), createGroup: true });
  assert.equal(result.status, 200, result.message);
  const uploaded = result.data;
  assert.equal(uploaded.acquisition, 'manual');
  assert.equal(uploaded.detectedFormat, 'mihomo'); // YAML content despite .json filename
  const connection = (node: any) => ({ type: node.type, server: node.server, port: node.port, cipher: node.cipher, password: node.password });
  assert.deepEqual(connection(uploaded.nodes[0]), connection(pasted.nodes[0]));
  assert.equal(uploaded.nodes[0].server, 'one.example');
  const services = (source: any) => source.doh.services.map(({ id: _id, ...service }: any) => service);
  assert.deepEqual(services(uploaded), services(pasted));
  assert.equal((await api(`/sources/${uploaded.id}/raw`)).data.content, content);
  await api(`/nodes/${uploaded.nodes[0].id}`, 'PUT', { name: 'File local', enabled: false });
  const replaced = await api(`/sources/${uploaded.id}`, 'PUT', { content: valid.replace('First', 'Renamed') });
  assert.equal(replaced.status, 200, replaced.message);
  const fromPaste = await api(`/sources/${pasted.id}`, 'PUT', fileInput(valid));
  assert.equal(fromPaste.status, 200, fromPaste.message);
  assert.equal(fromPaste.data.nodes[0].id, pasted.nodes[0].id);
  const uploadedAgain = await api(`/sources/${uploaded.id}`, 'PUT', fileInput(content));
  assert.equal(uploadedAgain.data.nodes[0].id, uploaded.nodes[0].id);
  assert.equal(uploadedAgain.data.nodes[0].name, 'File local');
  assert.equal(uploadedAgain.data.nodes[0].enabled, false);
  const group = (await api('/config')).data.proxyGroups.find((item: any) => item.id === `grp-${uploaded.id}`);
  assert.deepEqual(group.sources, [uploaded.id]);
  await stopApp(); await startApp();
  assert.deepEqual(await source(uploaded.id), uploadedAgain.data);
  assert.equal((await api(`/sources/${uploaded.id}/raw`)).data.content, content);
});

test('file original-byte limit includes BOM and permits exactly 1 MiB without counting JSON wrapping', async () => {
  const prefix = '\uFEFFproxies: []\n#';
  const exact = prefix + '中'.repeat(349520); // BOM + 13 ASCII + 1,048,560 UTF-8 bytes
  assert.equal(Buffer.byteLength(exact), 1_048_576);
  const added = await api('/sources', 'POST', { acquisition: 'manual', ...fileInput(exact) });
  assert.equal(added.status, 200, added.message);
  assert.equal((await api(`/sources/${added.data.id}/raw`)).data.content, exact);
  for (const content of [exact + 'x', exact + '中']) {
    assert.equal((await api('/sources', 'POST', { acquisition: 'manual', ...fileInput(content) })).status, 400);
    assert.equal((await api(`/sources/${added.data.id}`, 'PUT', fileInput(content))).status, 400);
    assert.equal((await api(`/sources/${added.data.id}/raw`)).data.content, exact);
  }
});

test('invalid file reads and unsupported file inputs leave saved raw and effective state unchanged', async () => {
  const initial = await add();
  const before = (await api('/config')).data;
  const invalid = [
    fileInput(Buffer.from([0xff, 0xfe, 0x70, 0x00])),
    fileInput(Buffer.from([0xc3, 0x28])),
    fileInput(Buffer.from('504b030400000000', 'hex'), 'archive.zip'),
    fileInput(Buffer.from('1f8b0800', 'hex'), 'archive.txt'),
    fileInput(Buffer.concat([Buffer.alloc(257), Buffer.from('ustar'), Buffer.alloc(10)]), 'archive.tar'),
    fileInput(valid, 'folder/subscription.yaml'),
    { contentFile: [fileInput(valid).contentFile, fileInput(valid).contentFile] },
    { contentFile: { name: 'input.txt', base64: 'not base64!' } },
    { contentFile: { name: 'input.txt', base64: 'YR==' } },
    { ...fileInput(valid), content: valid },
  ];
  for (const input of invalid) {
    const first = await api('/sources', 'POST', { acquisition: 'manual', createGroup: true, ...input });
    assert.equal(first.status, 400, JSON.stringify(input));
    assert.ok(first.message);
    const replacement = await api(`/sources/${initial.id}`, 'PUT', input);
    assert.equal(replacement.status, 400, replacement.message);
    assert.deepEqual((await api('/config')).data.sources, before.sources);
    assert.deepEqual((await api('/config')).data.proxyGroups, before.proxyGroups);
  }
  await stopApp(); await startApp();
  assert.deepEqual(await source(initial.id), initial);
});

test('file parse failures retain effective results and diagnostics, empty results clear, and storage failure publishes nothing', async () => {
  const before = (await api('/config')).data;
  const broken = valid.replace('password: secret', 'password: ""');
  assert.equal((await api('/sources', 'POST', { acquisition: 'manual', createGroup: true, ...fileInput(broken) })).status, 422);
  assert.deepEqual((await api('/config')).data.sources, before.sources);
  assert.deepEqual((await api('/config')).data.proxyGroups, before.proxyGroups);
  const initial = await add();
  assert.equal((await api(`/sources/${initial.id}`, 'PUT', fileInput(broken))).status, 422);
  const failed = await source(initial.id);
  assert.deepEqual(failed.nodes, initial.nodes);
  assert.deepEqual(failed.doh, initial.doh);
  const raw = (await api(`/sources/${initial.id}/raw`)).data;
  assert.equal(raw.content, broken);
  assert.equal(raw.parseStatus, 'failed');
  await stopApp(); await startApp();
  assert.deepEqual((await api(`/sources/${initial.id}/raw`)).data, raw);
  await chmod(join(directory, 'data'), 0o500);
  try {
    assert.equal((await api(`/sources/${initial.id}`, 'PUT', fileInput(valid))).status, 500);
    assert.equal((await api('/sources', 'POST', { acquisition: 'manual', ...fileInput(valid) })).status, 500);
    assert.deepEqual(await source(initial.id), failed);
  } finally { await chmod(join(directory, 'data'), 0o700); }
  await stopApp(); await startApp();
  assert.deepEqual(await source(initial.id), failed);
  const empty = await api(`/sources/${initial.id}`, 'PUT', fileInput('proxies: []\n'));
  assert.equal(empty.status, 200, empty.message);
  assert.deepEqual(empty.data.nodes, []);
  assert.deepEqual(empty.data.doh.services, []);
});

test('address switches through paste and file without changing source, node settings or group references, and resumes address updates', async () => {
  const path = '/switch-success';
  responses.set(path, { status: 200, body: valid });
  const added = await api('/sources', 'POST', { name: 'Switch source', url: upstreamOrigin + path, createGroup: true });
  assert.equal(added.status, 200, added.message);
  const initial = added.data;
  const node = initial.nodes[0];
  await api(`/nodes/${node.id}`, 'PUT', { name: 'Switch local', enabled: false });
  const group = (await api('/groups', 'POST', { name: 'Switch references', type: 'select', sources: [initial.id], proxies: [`node:${node.id}`] })).data;
  for (const input of [{ content: valid }, fileInput(valid)]) {
    const manual = await api(`/sources/${initial.id}`, 'PUT', { acquisition: 'manual', ...input });
    assert.equal(manual.status, 200, manual.message);
    assert.equal(manual.data.id, initial.id);
    assert.equal(manual.data.acquisition, 'manual');
    assert.equal(manual.data.url, undefined);
    assert.equal(manual.data.nodes[0].id, node.id);
    assert.equal(manual.data.nodes[0].name, 'Switch local');
    assert.equal(manual.data.nodes[0].enabled, false);
    const beforeRequests = requests.filter(url => url === path).length;
    const batch = await api('/sources/refresh-all', 'POST', {});
    assert.equal(batch.results.some((item: any) => item.sourceId === initial.id), false);
    assert.equal((await api(`/sources/${initial.id}/refresh`, 'POST', {})).status, 400);
    assert.equal(requests.filter(url => url === path).length, beforeRequests);
    await stopApp(); await startApp();
    assert.deepEqual(await source(initial.id), manual.data);
    const config = (await api('/config')).data;
    assert.deepEqual(config.proxyGroups.find((item: any) => item.id === group.id), group);
    assert.equal(config.sources.filter((item: any) => item.id === initial.id).length, 1);
    const remote = await api(`/sources/${initial.id}`, 'PUT', { acquisition: 'url', url: upstreamOrigin + path });
    assert.equal(remote.status, 200, remote.message);
    assert.equal(remote.data.nodes[0].id, node.id);
    assert.equal(remote.data.nodes[0].name, 'Switch local');
    assert.equal(remote.data.nodes[0].enabled, false);
    assert.equal(remote.data.url, upstreamOrigin + path);
    assert.equal(remote.data.acquisition, 'url');
    assert.equal((await api('/sources/refresh-all', 'POST', {})).results.find((item: any) => item.sourceId === initial.id).success, true);
    assert.equal(requests.filter(url => url === path).length, beforeRequests + 2);
    await api(`/sources/${initial.id}`, 'PUT', { enabled: false });
    const disabledRequests = requests.filter(url => url === path).length;
    assert.equal((await api('/sources/refresh-all', 'POST', {})).results.some((item: any) => item.sourceId === initial.id), false);
    assert.equal(requests.filter(url => url === path).length, disabledRequests);
    await api(`/sources/${initial.id}`, 'PUT', { enabled: true });
    await stopApp(); await startApp();
    assert.equal((await source(initial.id)).acquisition, 'url');
  }
});

test('failed cross-mode reads, validation and parses preserve active intent and references separately from diagnostic raw after reboot', async () => {
  const path = '/switch-failure';
  responses.set(path, { status: 200, body: valid });
  const remote = (await api('/sources', 'POST', { url: upstreamOrigin + path, name: 'Keep address', createGroup: true })).data;
  const manual = await add(valid, { name: 'Keep manual', createGroup: true });
  const effective = (item: any) => Object.fromEntries(['id', 'name', 'acquisition', 'url', 'nodes', 'infoNodes', 'doh', 'lastUpdated', 'parsedConfig'].map(field => [field, item[field]]));
  const groups = (await api('/config')).data.proxyGroups;
  for (const input of [
    { acquisition: 'manual' },
    { acquisition: 'manual', content: 'x'.repeat(1_048_577) },
    { acquisition: 'manual', ...fileInput(Buffer.from([0xc3, 0x28])) },
    { acquisition: 'url', url: 'file:///invalid' },
    { acquisition: 'invalid', content: valid },
  ]) {
    assert.equal((await api(`/sources/${remote.id}`, 'PUT', input)).status, 400);
    assert.deepEqual(await source(remote.id), remote);
  }
  for (const input of [{ acquisition: 'url' }, { acquisition: 'url', url: 'invalid' }, { acquisition: 'url', url: upstreamOrigin + path, content: valid }]) {
    assert.equal((await api(`/sources/${manual.id}`, 'PUT', input)).status, 400);
    assert.deepEqual(await source(manual.id), manual);
  }
  const broken = valid.replace('https://dns.example/dns-query', 'https://');
  for (const input of [{ content: broken }, fileInput(broken)]) {
    const result = await api(`/sources/${remote.id}`, 'PUT', { acquisition: 'manual', name: 'Rejected manual', ...input });
    assert.equal(result.status, 422, result.message);
    assert.deepEqual(effective(await source(remote.id)), effective(remote));
    const raw = (await api(`/sources/${remote.id}/raw`)).data;
    assert.equal(raw.content, broken);
    assert.equal(raw.parseStatus, 'failed');
    assert.equal(raw.lastSuccessfulUpdate, remote.lastUpdated);
    await stopApp(); await startApp();
    assert.deepEqual(effective(await source(remote.id)), effective(remote));
    assert.deepEqual((await api(`/sources/${remote.id}/raw`)).data, raw);
  }
  responses.set(path, { status: 503, body: 'offline' });
  assert.equal((await api(`/sources/${manual.id}`, 'PUT', { acquisition: 'url', url: upstreamOrigin + path, name: 'Rejected address' })).status, 500);
  assert.deepEqual(effective(await source(manual.id)), effective(manual));
  assert.deepEqual((await source(manual.id)).rawSubscription, manual.rawSubscription);
  responses.set(path, { status: 200, body: broken });
  assert.equal((await api(`/sources/${manual.id}`, 'PUT', { acquisition: 'url', url: upstreamOrigin + path })).status, 422);
  assert.deepEqual(effective(await source(manual.id)), effective(manual));
  const failedManual = await source(manual.id);
  const raw = (await api(`/sources/${manual.id}/raw`)).data;
  assert.equal(raw.content, broken);
  assert.equal(raw.parseStatus, 'failed');
  // Settings-only edits remain possible despite a failed diagnostic document.
  const metadata = await api(`/sources/${manual.id}`, 'PUT', { acquisition: 'manual', name: 'Manual metadata' });
  assert.equal(metadata.status, 200, metadata.message);
  assert.equal(metadata.data.lastUpdated, manual.lastUpdated);
  assert.deepEqual(metadata.data.rawSubscription, failedManual.rawSubscription);
  await stopApp(); await startApp();
  assert.deepEqual(await source(manual.id), metadata.data);
  assert.deepEqual((await api('/config')).data.proxyGroups, groups);
});

test('storage failures do not publish either direction of acquisition switching or its diagnostic document', async () => {
  responses.set('/switch-save', { status: 200, body: valid });
  const remote = (await api('/sources', 'POST', { url: upstreamOrigin + '/switch-save', name: 'Saved URL', createGroup: true })).data;
  const manual = await add(valid, { name: 'Saved manual', createGroup: true });
  const before = (await api('/config')).data;
  await chmod(join(directory, 'data'), 0o500);
  try {
    for (const input of [{ content: valid }, fileInput(valid), { content: 'unknown' }]) {
      assert.equal((await api(`/sources/${remote.id}`, 'PUT', { acquisition: 'manual', ...input })).status, 500);
    }
    assert.equal((await api(`/sources/${manual.id}`, 'PUT', { acquisition: 'url', url: upstreamOrigin + '/switch-save' })).status, 500);
    responses.set('/switch-save', { status: 200, body: 'unknown' });
    assert.equal((await api(`/sources/${manual.id}`, 'PUT', { acquisition: 'url', url: upstreamOrigin + '/switch-save' })).status, 500);
    assert.deepEqual((await api('/config')).data.sources, before.sources);
    assert.deepEqual((await api('/config')).data.proxyGroups, before.proxyGroups);
  } finally { await chmod(join(directory, 'data'), 0o700); }
  await stopApp(); await startApp();
  assert.deepEqual((await api('/config')).data.sources, before.sources);
  assert.deepEqual((await api('/config')).data.proxyGroups, before.proxyGroups);
});

test('switched file content and then address content replace the effective DoH batch used by representative downstream output', async () => {
  const path = '/switch-output';
  responses.set(path, { status: 200, body: valid });
  const initial = (await api('/sources', 'POST', { url: upstreamOrigin + path, name: 'Switch output' })).data;
  const group = (await api('/groups', 'POST', { name: 'Switch output group', type: 'select', sources: [initial.id], proxies: [`node:${initial.nodes[0].id}`] })).data;
  const template = (await api('/templates', 'POST', { name: 'Switch output template', type: 'mihomo', content: 'proxies: []\nproxy-groups: []\ndns:\n  enable: true\n  nameserver: [https://template.example/dns-query]\n  default-nameserver: [1.1.1.1]\n  proxy-server-nameserver: [1.1.1.1]\nrules: ["MATCH,DIRECT"]\n' })).data;
  const profile = (await api('/profiles', 'POST', { name: 'Switch output profile', nodeFilter: { mode: 'all', sourceIds: [initial.id] }, selectedGroupIds: [group.id], templates: { mihomo: template.id } })).data;
  await api(`/nodes/${initial.nodes[0].id}`, 'PUT', { name: 'Stable output local' });
  const switched = await api(`/sources/${initial.id}`, 'PUT', { acquisition: 'manual', ...fileInput(valid.replace('dns.example', 'new-dns.example').replace('custom: preserved', '')) });
  assert.equal(switched.status, 200, switched.message);
  assert.equal(switched.data.nodes[0].id, initial.nodes[0].id);
  assert.equal(switched.data.doh.services.length, 1);
  await stopApp(); await startApp();
  const output = await fetch(`${origin}/s/${profile.token}/mihomo?expand=true`).then(response => response.text());
  assert.match(output, /Stable output local/);
  assert.match(output, /new-dns.example\/dns-query/);
  assert.doesNotMatch(output, /https:\/\/dns.example\/dns-query/);
  responses.set(path, { status: 200, body: 'proxies:\n - {name: Changed upstream name, type: ss, server: one.example, port: 443, cipher: aes-128-gcm, password: secret}\n' });
  const address = await api(`/sources/${initial.id}`, 'PUT', { acquisition: 'url', url: upstreamOrigin + path });
  assert.equal(address.status, 200, address.message);
  assert.deepEqual(address.data.doh.services, []);
  assert.equal(address.data.nodes[0].id, initial.nodes[0].id);
  await stopApp(); await startApp();
  const resumed = await fetch(`${origin}/s/${profile.token}/mihomo?expand=true`).then(response => response.text());
  assert.match(resumed, /Stable output local/);
  assert.doesNotMatch(resumed, /new-dns.example/);
  assert.match(resumed, /template.example\/dns-query/);
});


test('legacy source without acquisition remains an address regardless of format hint until a successful switch', async () => {
  const legacy = await source('legacy-switch');
  assert.equal(legacy.acquisition, undefined);
  assert.equal(legacy.type, 'manual');
  responses.set('/legacy-switch', { status: 200, body: valid });
  const refreshed = await api('/sources/legacy-switch/refresh', 'POST', {});
  assert.equal(refreshed.status, 200, refreshed.message);
  const switched = await api('/sources/legacy-switch', 'PUT', { acquisition: 'manual', content: valid });
  assert.equal(switched.status, 200, switched.message);
  assert.equal(switched.data.id, legacy.id);
  assert.equal(switched.data.acquisition, 'manual');
  assert.equal(switched.data.url, undefined);
  assert.equal(switched.data.nodes[0].id, refreshed.source.nodes[0].id);
  await stopApp(); await startApp();
  assert.deepEqual(await source(legacy.id), switched.data);
});
