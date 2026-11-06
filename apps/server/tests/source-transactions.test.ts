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

test('first add commits only a complete successful upstream and serves its exact raw after restart', async () => {
  body = '<html>upstream error</html>';
  const failed = await api('/sources', 'POST', { name: 'Failed', url: upstreamOrigin, createGroup: true });
  assert.equal(failed.success, false);
  assert.equal(failed.status, 422);
  const afterFailure = await api('/config');
  assert.deepEqual(afterFailure.data.sources, []);
  assert.equal(afterFailure.data.proxyGroups.some((group: any) => group.name === 'Failed'), false);
  body = valid;
  const created = await api('/sources', 'POST', { name: 'Airport', url: upstreamOrigin, createGroup: true });
  assert.equal(created.status, 200);
  assert.equal(created.data.nodeCount, 1);
  assert.equal(created.data.detectedFormat, 'mihomo');
  const id = created.data.id;
  const raw = await api(`/sources/${id}/raw`);
  assert.equal(raw.data.content, valid);
  assert.equal(raw.data.parseStatus, 'success');
  assert.equal(raw.data.format, 'mihomo');
  assert.equal(raw.data.contentType, 'text/yaml; charset=utf-8');
  assert.equal(raw.data.fetchedAt, created.data.lastUpdated);
  assert.equal(raw.data.lastSuccessfulUpdate, created.data.lastUpdated);
  await stopApp();
  await startApp();
  const reloaded = await api(`/sources/${id}/raw`);
  assert.deepEqual(reloaded.data, raw.data);
  assert.equal((await api('/sources')).data[0].nodes[0].name, 'First');
});

test('failed refresh preserves the effective batch while saving only a complete failed raw response', async () => {
  const original = (await api('/sources')).data[0];
  body = 'proxies:\n  - { name: Replacement, type: ss, server: new.example, port: 443, cipher: aes-128-gcm, password: secret }\n  - { name: Broken, type: ss, port: 443 }\n';
  const failed = await api(`/sources/${original.id}/refresh`, 'POST', {});
  assert.equal(failed.success, false);
  const current = (await api('/sources')).data[0];
  for (const field of ['nodes', 'nodeCount', 'infoNodes', 'subscriptionInfo', 'lastUpdated', 'parsedConfig']) {
    assert.deepEqual(current[field], original[field], field);
  }
  assert.match(current.lastUpdateError, /解析不完整/);
  const raw = (await api(`/sources/${original.id}/raw`)).data;
  assert.equal(raw.content, body);
  assert.equal(raw.parseStatus, 'failed');
  assert.equal(raw.lastSuccessfulUpdate, original.lastUpdated);
  assert.notEqual(raw.fetchedAt, original.lastUpdated);
  await stopApp();
  await startApp();
  assert.deepEqual((await api(`/sources/${original.id}/raw`)).data, raw);
  assert.deepEqual((await api('/sources')).data[0].nodes, original.nodes);
  status = 503;
  body = 'temporarily unavailable';
  assert.equal((await api(`/sources/${original.id}/refresh`, 'POST', {})).success, false);
  assert.deepEqual((await api(`/sources/${original.id}/raw`)).data, raw);
  status = 200;
});

test('whole input validation rejects every incomplete target while recognized empty lists clear a source', async () => {
  const id = (await api('/sources')).data[0].id;
  const invalid = [
    '', '   \n', '<html>error</html>',
    'proxies: [',
    'proxies:\n - {name: Missing credentials, type: ss, server: broken.example, port: 443}',
    'proxies:\n - {name: Unknown protocol, type: imaginary, server: broken.example, port: 443}',
    'proxies:\n - {name: Bad port, type: ss, server: broken.example, port: 70000, cipher: none}',
    'ss://YWVzLTEyOC1nY206c2VjcmV0@one.example:443#Good\nss://broken',
    '[server_local]\nshadowsocks=one.example:443, method=aes-128-gcm, password=secret, tag=Good\nshadowsocks=broken.example:443, tag=Broken',
    '{"outbounds":[{"type":"direct","tag":"direct"},{"type":"shadowsocks","tag":"Broken","server":"one.example","server_port":443}]}',
  ];
  for (const content of invalid) {
    body = content;
    const result = await api(`/sources/${id}/refresh`, 'POST', {});
    assert.equal(result.success, false, content);
    assert.equal((await api('/sources')).data[0].nodeCount, 1, content);
    if (content.includes('<html>')) assert.equal((await api(`/sources/${id}/raw`)).data.format, undefined);
  }
  for (const content of ['proxies: []\n', '{"outbounds":[]}', '[server_local]\n']) {
    body = content;
    const result = await api(`/sources/${id}/refresh`, 'POST', {});
    assert.equal(result.success, true, content);
    assert.equal(result.nodeCount, 0);
    assert.deepEqual(result.data, []);
  }
  body = Buffer.from(valid).toString('base64');
  assert.equal((await api(`/sources/${id}/refresh`, 'POST', {})).nodeCount, 1);
  const raw = (await api(`/sources/${id}/raw`)).data;
  assert.equal(raw.content, body);
  assert.equal(raw.format, 'mihomo');
});

test('Base64 structured raw retains its encoding and exact body after success, failed parsing and reload', async () => {
  const cases = [
    ['mihomo', valid, 'proxies:\n - {name: Broken, type: ss, port: 443}\n'],
    ['singbox', '{"outbounds":[{"type":"socks","tag":"Wrapped","server":"wrapped.example","server_port":1080}]}', '{"outbounds":[{"type":"socks","tag":"Broken","server_port":1080}]}'],
    ['quantumultx', '[server_local]\nshadowsocks=wrapped.example:443, method=aes-128-gcm, password=secret, tag=Wrapped', '[server_local]\nshadowsocks=broken.example:443, tag=Broken'],
  ];
  for (const [format, complete, incomplete] of cases) {
    const path = `/wrapped-${format}`;
    const encoded = `  ${Buffer.from(complete).toString('base64')}\n`;
    responses.set(path, { status: 200, body: encoded });
    const added = await api('/sources', 'POST', { name: `Wrapped ${format}`, url: upstreamOrigin + path });
    assert.equal(added.success, true, added.message);
    assert.equal(added.data.detectedFormat, format);
    const raw = (await api(`/sources/${added.data.id}/raw`)).data;
    assert.equal(raw.content, encoded);
    assert.equal(raw.format, format);
    assert.equal(raw.encoding, 'base64');
    await stopApp(); await startApp();
    assert.deepEqual((await api(`/sources/${added.data.id}/raw`)).data, raw);

    const failedBody = `\n${Buffer.from(incomplete).toString('base64')}  `;
    responses.set(path, { status: 200, body: failedBody });
    const failed = await api(`/sources/${added.data.id}/refresh`, 'POST', {});
    assert.equal(failed.status, 422);
    const failedRaw = (await api(`/sources/${added.data.id}/raw`)).data;
    assert.equal(failedRaw.content, failedBody);
    assert.equal(failedRaw.format, format);
    assert.equal(failedRaw.encoding, 'base64');
    assert.equal(failedRaw.parseStatus, 'failed');
    assert.equal(failedRaw.lastSuccessfulUpdate, added.data.lastUpdated);
    await stopApp(); await startApp();
    assert.deepEqual((await api(`/sources/${added.data.id}/raw`)).data, failedRaw);
    assert.deepEqual((await api('/sources')).data.find((source: any) => source.id === added.data.id).nodes, added.data.nodes);
  }
});

test('persistence failure reports failure and publishes no source or effective update', async () => {
  body = valid;
  const before = (await api('/sources')).data;
  await chmod(join(directory, 'data'), 0o500);
  try {
    const add = await api('/sources', 'POST', { name: 'Unsaved', url: upstreamOrigin, createGroup: true });
    assert.equal(add.status, 500);
    assert.equal(add.success, false);
    assert.deepEqual((await api('/sources')).data, before);
    body = valid.replace('First', 'Unsaved replacement');
    const refresh = await api(`/sources/${before[0].id}/refresh`, 'POST', {});
    assert.equal(refresh.status, 500);
    assert.equal(refresh.success, false);
    assert.deepEqual((await api('/sources')).data, before);
    body = '<html>parse failed, raw must not be claimed saved</html>';
    const failedRaw = await api(`/sources/${before[0].id}/refresh`, 'POST', {});
    assert.equal(failedRaw.status, 500);
    assert.deepEqual((await api('/sources')).data, before);
  } finally { await chmod(join(directory, 'data'), 0o700); }
  await stopApp();
  await startApp();
  assert.deepEqual((await api('/sources')).data, before);
});

test('matching rules validate, persist and reclassify cached information nodes without another fetch', async () => {
  body = 'proxies:\n - {name: "Traffic used 1 GB / 10 GB", type: ss, server: info.example, port: 443, cipher: none}\n - {name: "Expiry 2030-01-01", type: ss, server: expiry.example, port: 443, cipher: none}\n - {name: Proxy, type: ss, server: proxy.example, port: 443, cipher: none}\n';
  const created = await api('/sources', 'POST', { name: 'Information', url: upstreamOrigin, trafficNodeRegex: '  TRAFFIC  ', expiryNodeRegex: 'expiry' });
  assert.equal(created.success, true);
  assert.equal(created.data.nodeCount, 1);
  assert.equal(created.data.infoNodes.length, 2);
  assert.equal(created.data.trafficNodeRegex, 'TRAFFIC');
  const id = created.data.id;
  const invalid = await api(`/sources/${id}`, 'PUT', { trafficNodeRegex: '[' });
  assert.equal(invalid.status, 400);
  assert.equal((await api('/sources')).data.find((s: any) => s.id === id).trafficNodeRegex, 'TRAFFIC');
  status = 503; // Rules-only editing uses the cached complete result.
  const cleared = await api(`/sources/${id}`, 'PUT', { trafficNodeRegex: ' ', expiryNodeRegex: '' });
  assert.equal(cleared.success, true);
  assert.equal(cleared.data.nodeCount, 3);
  assert.deepEqual(cleared.data.infoNodes, []);
  assert.equal(cleared.data.lastUpdated, created.data.lastUpdated);
  const failedEdit = await api(`/sources/${id}`, 'PUT', { name: 'Must not save', url: `${upstreamOrigin}/new`, trafficNodeRegex: 'traffic' });
  assert.equal(failedEdit.success, false);
  const unchanged = (await api('/sources')).data.find((s: any) => s.id === id);
  assert.equal(unchanged.name, 'Information');
  assert.equal(unchanged.url, upstreamOrigin);
  assert.equal(unchanged.nodeCount, 3);
  await stopApp();
  await startApp();
  assert.deepEqual((await api('/sources')).data.find((s: any) => s.id === id), unchanged);
  status = 200;
});

test('batch updates save each upstream independently and report the failed upstream', async () => {
  body = valid;
  const a = await api('/sources', 'POST', { name: 'Batch A', url: `${upstreamOrigin}/a` });
  const b = await api('/sources', 'POST', { name: 'Batch B', url: `${upstreamOrigin}/b` });
  responses.set('/a', { status: 200, body: valid.replace('First', 'New A') });
  responses.set('/b', { status: 200, body: 'proxies:\n - {name: broken}' });
  const refreshed = await api('/sources/refresh-all', 'POST', {});
  assert.equal(refreshed.status, 200);
  assert.equal(refreshed.success, false);
  assert.equal(refreshed.results.find((result: any) => result.sourceId === a.data.id).success, true);
  assert.equal(refreshed.results.find((result: any) => result.sourceId === b.data.id).success, false);
  const listed = (await api('/sources')).data;
  assert.equal(listed.find((source: any) => source.id === a.data.id).nodes[0].name, 'New A');
  assert.deepEqual(listed.find((source: any) => source.id === b.data.id).nodes, b.data.nodes);
  await stopApp();
  await startApp();
  assert.deepEqual((await api('/sources')).data, listed);
});

test('network and incomplete response failures never replace saved raw or create failed first sources', async () => {
  responses.set('/complete', { status: 200, body: valid });
  const created = await api('/sources', 'POST', { name: 'Readable', url: `${upstreamOrigin}/complete` });
  const raw = (await api(`/sources/${created.data.id}/raw`)).data;
  responses.set('/complete', { status: 200, body: 'proxies: []', truncated: true });
  assert.equal((await api(`/sources/${created.data.id}/refresh`, 'POST', {})).success, false);
  assert.deepEqual((await api(`/sources/${created.data.id}/raw`)).data, raw);
  const previous = (await api('/config')).data;
  for (const url of [`${upstreamOrigin}/complete`, 'http://127.0.0.1:1/unreachable']) {
    const first = await api('/sources', 'POST', { name: 'Failed transport', url, createGroup: true });
    assert.equal(first.success, false);
    const current = (await api('/config')).data;
    assert.deepEqual(current.sources, previous.sources);
    assert.deepEqual(current.proxyGroups, previous.proxyGroups);
  }
});
