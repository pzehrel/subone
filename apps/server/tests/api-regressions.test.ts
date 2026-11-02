import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import express from 'express';
import type { AppConfig, ProxyNode, SubscriptionProfile, SubscriptionSource } from '../src/types/index';

const originalDirectory = process.cwd();
const originalRoot = process.env.SUBONE_ROOT;
let temporaryDirectory: string;
let server: Server | undefined;
let origin: string;
let context: typeof import('../src/context');

function fixture(): AppConfig {
  return {
    sources: [],
    rules: [],
    templates: [],
    proxyGroups: [],
    rulesList: [],
    profiles: [],
    settings: { port: 3456 },
  };
}

before(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'subone-api-regressions-'));
  await mkdir(join(temporaryDirectory, 'data'));
  await writeFile(join(temporaryDirectory, 'data', 'subone_data.json'), JSON.stringify(fixture()));
  process.chdir(temporaryDirectory);
  process.env.SUBONE_ROOT = temporaryDirectory;
  context = await import('../src/context');
  const { apiRouter } = await import('../src/routes/api');
  const { subRouter } = await import('../src/routes/sub');
  const app = express();
  app.use(express.json());
  app.use(apiRouter);
  app.use(subRouter);
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  origin = `http://127.0.0.1:${address.port}`;
});

beforeEach(() => {
  context.setAppConfig(fixture());
  context.setGlobalNodesCache([]);
});

after(async () => {
  const activeServer = server;
  if (activeServer) {
    await new Promise<void>((resolve, reject) => activeServer.close(error => error ? reject(error) : resolve()));
  }
  process.chdir(originalDirectory);
  if (originalRoot === undefined) delete process.env.SUBONE_ROOT;
  else process.env.SUBONE_ROOT = originalRoot;
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
});

async function readApiResponse<T>(response: Response) {
  return await response.json() as { success: boolean; data: T; message: string };
}

async function post<T = SubscriptionProfile>(path: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await readApiResponse<T>(response) };
}

test('info rules immediately reclassify cached nodes and filter every subscription format without refetching', async () => {
  const config = fixture();
  const names = ['Hong Kong', '剩余流量：128 GB', '套餐到期：2026-12-31'];
  config.sources = [{
    id: 'airport', name: 'Airport', type: 'remote', enabled: true,
    url: 'http://127.0.0.1:1/expired-subscription',
    nodes: names.map((name, index) => ({ id: `node-${index}`, name, type: 'ss', server: 'example.test', port: 443, method: 'aes-128-gcm', password: 'test' })),
    lastUpdated: '2026-11-01T00:00:00Z',
  }];
  config.profiles = [{ id: 'profile', name: 'Phone', token: 'info-test', enabled: true, nodeFilter: { mode: 'all' } }];
  context.setAppConfig(config);
  const update = async (body: unknown) => {
    const response = await fetch(`${origin}/api/sources/airport`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await readApiResponse<SubscriptionSource>(response) };
  };
  const result = await update({ trafficNodeRegex: '剩余流量', expiryNodeRegex: '套餐到期' });
  assert.equal(result.status, 200);
  assert.equal(result.body.data.nodeCount, 1);
  assert.equal(result.body.data.infoNodes?.length, 2);
  assert.equal(result.body.data.subscriptionInfo?.trafficText, names[1]);
  assert.equal(result.body.data.subscriptionInfo?.expiryText, names[2]);
  assert.equal(result.body.data.lastUpdated, '2026-11-01T00:00:00Z');
  assert.equal(context.getGlobalNodesCache().length, 1);

  for (const target of ['mihomo', 'singbox', 'loon', 'qx', 'egern', 'shadowrocket']) {
    const response = await fetch(`${origin}/s/info-test/${target}?expand=true`);
    assert.equal(response.status, 200);
    const output = await response.text();
    assert.ok(output.includes('Hong Kong'));
    assert.ok(!output.includes('剩余流量'));
    assert.ok(!output.includes('套餐到期'));
  }
  for (const target of ['mihomo', 'loon', 'qx', 'egern']) {
    const response = await fetch(`${origin}/s/info-test/${target}`);
    assert.equal(response.status, 200);
    const output = await response.text();
    assert.ok(output.includes(`${origin}/s/info-test/source/airport?target=`));
    assert.ok(!output.includes('expired-subscription'));
    const sourceResponse = await fetch(`${origin}/s/info-test/source/airport?target=${target}`);
    assert.equal(sourceResponse.status, 200);
    assert.ok(!(await sourceResponse.text()).includes('剩余流量'));
    assert.equal(sourceResponse.headers.get('subscription-userinfo'), null);
  }

  const beforeFailure = structuredClone(context.getAppConfig().sources[0]);
  const invalid = await update({ name: 'Should not be saved', trafficNodeRegex: '[' });
  assert.equal(invalid.status, 400);
  assert.deepEqual(context.getAppConfig().sources[0], beforeFailure);
  const refresh = await post('/api/sources/airport/refresh', {});
  assert.equal(refresh.status, 500);
  assert.deepEqual(context.getAppConfig().sources[0], beforeFailure);

  const restored = await update({ trafficNodeRegex: '', expiryNodeRegex: '' });
  assert.equal(restored.body.data.nodeCount, 3);
  assert.deepEqual(restored.body.data.infoNodes, []);
  assert.equal(restored.body.data.subscriptionInfo, undefined);
});

test('source creation, URL changes and refresh preserve upstream metadata', async t => {
  let expire = 1893456000;
  const upstream = createServer((_request, response) => {
    response.setHeader('Subscription-Userinfo', `upload=0; download=1024; total=2048; expire=${expire}`);
    response.end('proxies:\n  - {name: "Hong Kong", type: ss, server: example.test, port: 443, cipher: aes-128-gcm, password: test}\n  - {name: "剩余流量：128 GB", type: ss, server: example.test, port: 443, cipher: aes-128-gcm, password: test}');
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(() => new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve())));
  const address = upstream.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/sub`;
  const invalid = await post('/api/sources', { name: 'Invalid', url, expiryNodeRegex: '[' });
  assert.equal(invalid.status, 400);
  const created = await post<SubscriptionSource>('/api/sources', { name: 'Airport', url, trafficNodeRegex: '剩余流量' });
  assert.equal(created.status, 200);
  const source = created.body.data;
  assert.equal(source.nodes?.length, 1);
  assert.equal(source.infoNodes?.length, 1);
  assert.equal(source.subscriptionInfo?.download, 1024);
  assert.equal(source.subscriptionInfo?.trafficText, undefined);
  context.getAppConfig().profiles = [{ id: 'profile', name: 'Phone', token: 'info-test', enabled: true, nodeFilter: { mode: 'all' } }];
  const response = await fetch(`${origin}/s/info-test/source/${source.id}?target=mihomo`);
  assert.equal(response.headers.get('subscription-userinfo'), 'upload=0; download=1024; total=2048; expire=1893456000');

  expire += 86400;
  const changed = await fetch(`${origin}/api/sources/${source.id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: `${url}?new=1` }),
  });
  assert.equal((await readApiResponse<SubscriptionSource>(changed)).data.subscriptionInfo?.expire, expire);
  expire += 86400;
  assert.equal((await post(`/api/sources/${source.id}/refresh`, {})).status, 200);
  assert.equal(context.getAppConfig().sources.find(s => s.id === source.id)?.subscriptionInfo?.expire, expire);
  expire += 86400;
  assert.equal((await post('/api/sources/refresh-all', {})).status, 200);
  assert.equal(context.getAppConfig().sources.find(s => s.id === source.id)?.subscriptionInfo?.expire, expire);
});

test('preview rejects unsupported relay groups with a client error', async () => {
  const config = fixture();
  config.proxyGroups = [{ id: 'chain', name: 'Chain', type: 'relay', proxies: ['Entry', 'Exit'] }];
  context.setAppConfig(config);

  for (const customType of ['mihomo', 'quantumultx']) {
    const result = await post<string>('/api/generate/preview', {
      customType,
      customTemplate: customType === 'mihomo' ? 'proxy-groups: []\nrules: []' : '[policy]\n[filter_local]\n',
    });
    assert.equal(result.status, 422);
    assert.equal(result.body.success, false);
    assert.match(result.body.message, /Chain/);
  }
});

test('custom-node endpoints handle subscriptions without a manual node group', async () => {
  const config = fixture();
  config.sources = [{ id: 'airport', name: 'Airport', type: 'remote', enabled: true, url: 'https://airport.example.test/sub' }];
  context.setAppConfig(config);

  const response = await fetch(`${origin}/api/custom-nodes`);
  assert.equal(response.status, 200);
  assert.deepEqual((await readApiResponse<ProxyNode[]>(response)).data, []);

  const imported = await post('/api/custom-nodes/import', { text: '', replaceAll: true });
  assert.equal(imported.status, 404);
  assert.equal(imported.body.success, false);

  const added = await post('/api/custom-nodes', { name: 'Node', type: 'ss', server: 'example.test', port: 443 });
  assert.equal(added.status, 404);
  assert.equal(added.body.success, false);
});

test('a new profile receives a generated token and can be retrieved', async () => {
  const created = await post('/api/profiles', { name: 'Phone' });
  assert.equal(created.status, 200);
  assert.equal(created.body.success, true);
  assert.match(created.body.data.token, /^[a-f0-9]{32}$/);

  const response = await fetch(`${origin}/api/profiles`);
  assert.equal(response.status, 200);
  const listed = await readApiResponse<SubscriptionProfile[]>(response);
  assert.deepEqual(listed.data, [created.body.data]);
});

test('refreshing a profile token replaces its subscription token', async () => {
  const created = await post('/api/profiles', { name: 'Laptop' });
  assert.equal(created.status, 200);
  const refreshed = await post(`/api/profiles/${created.body.data.id}/refresh-token`, {});
  assert.equal(refreshed.status, 200);
  assert.equal(refreshed.body.success, true);
  assert.match(refreshed.body.data.token, /^[a-f0-9]{32}$/);
  assert.notEqual(refreshed.body.data.token, created.body.data.token);

  const response = await fetch(`${origin}/api/profiles`);
  const listed = await readApiResponse<SubscriptionProfile[]>(response);
  assert.equal(listed.data[0].token, refreshed.body.data.token);
});

test('preview provider links use the external HTTPS host and the selected profile token', async () => {
  const config = fixture();
  config.sources = [{ id: 'manual', name: 'Manual', type: 'manual', enabled: true, nodes: [] }];
  config.proxyGroups = [{ id: 'manual-group', name: 'Manual', type: 'select', sources: ['manual'] }];
  context.setAppConfig(config);
  const created = await post('/api/profiles', { name: 'Mihomo' });
  assert.equal(created.status, 200);

  const result = await post<string>('/api/generate/preview', {
    profileId: created.body.data.id,
    customType: 'mihomo',
    customTemplate: 'proxy-groups: []\nrules: []',
  }, {
    'X-Forwarded-Proto': 'https',
    'X-Forwarded-Host': 'subscriptions.example.test',
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.success, true);
  assert.ok(result.body.data.includes(
    `https://subscriptions.example.test/s/${created.body.data.token}/source/manual?target=mihomo`,
  ));
});

test('unexpected generation errors retain the server-error response', async () => {
  const config = fixture();
  config.proxyGroups = [{ id: 'broken', name: 'Broken regex', type: 'select', filter: '[' }];
  context.setAppConfig(config);

  const result = await post<string>('/api/generate/preview', {
    customType: 'mihomo',
    customTemplate: 'proxy-groups: []\nrules: []',
    expandNodes: true,
  });
  assert.equal(result.status, 500);
  assert.equal(result.body.success, false);
  assert.match(result.body.message, /regular expression|character class/i);
});

test('Mihomo and Quantumult X subscriptions reject unsupported relay groups', async () => {
  const config = fixture();
  config.proxyGroups = [{ id: 'chain', name: 'Chain', type: 'relay', proxies: ['Entry', 'Exit'] }];
  context.setAppConfig(config);
  const created = await post('/api/profiles', { name: 'Relay subscription' });
  assert.equal(created.status, 200);

  for (const target of ['mihomo', 'qx']) {
    const response = await fetch(`${origin}/s/${created.body.data.token}/${target}`);
    assert.equal(response.status, 422);
    assert.match(response.headers.get('content-type') || '', /text\/plain/);
    assert.match(await response.text(), /Chain/);
  }
});

test('classical rule subscriptions authorize before fetching and convert domain and IPv6 rules', async t => {
  let upstreamReads = 0;
  const upstream = createServer((_request, response) => {
    upstreamReads += 1;
    response.writeHead(200, { 'Content-Type': 'text/yaml' });
    response.end('payload:\n  - DOMAIN,api.example.test\n  - IP-CIDR,2001:db8::/32,no-resolve\n');
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(async () => {
    await new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()));
  });
  const address = upstream.address();
  assert.ok(address && typeof address !== 'string');

  const config = fixture();
  config.rulesList = [{
    id: 'classical',
    name: 'Classical rules',
    kind: 'remote',
    type: 'RULE-SET',
    payload: `http://127.0.0.1:${address.port}/rules.yaml`,
    behavior: 'classical',
    outbound: 'DIRECT',
    enabled: true,
  }, {
    id: 'other-rule',
    name: 'Other rule',
    kind: 'local',
    type: 'DOMAIN',
    payload: 'other.example.test',
    outbound: 'DIRECT',
    enabled: true,
  }];
  const profile: SubscriptionProfile = {
    id: 'qx-profile',
    name: 'QX',
    token: 'qx-rule-test-token',
    nodeFilter: { mode: 'all' },
    enabled: true,
    selectedRuleIds: ['classical'],
  };
  config.profiles = [profile];
  context.setAppConfig(config);

  const invalidToken = await fetch(`${origin}/s/invalid-token/rules/classical/qx`);
  assert.equal(invalidToken.status, 404);
  assert.equal(await invalidToken.text(), '404 Not Found');
  assert.equal(upstreamReads, 0);

  profile.enabled = false;
  const disabledProfile = await fetch(`${origin}/s/${profile.token}/rules/classical/qx`);
  assert.equal(disabledProfile.status, 404);
  assert.equal(await disabledProfile.text(), '404 Not Found');
  assert.equal(upstreamReads, 0);

  profile.enabled = true;
  profile.selectedRuleIds = ['other-rule'];
  const excludedRule = await fetch(`${origin}/s/${profile.token}/rules/classical/qx`);
  assert.equal(excludedRule.status, 404);
  assert.equal(await excludedRule.text(), '404 Not Found');
  assert.equal(upstreamReads, 0);

  profile.selectedRuleIds = ['classical'];
  const converted = await fetch(`${origin}/s/${profile.token}/rules/classical/qx`);
  assert.equal(converted.status, 200);
  assert.match(converted.headers.get('content-type') || '', /text\/plain/);
  assert.equal(await converted.text(), 'host,api.example.test,direct\nip6-cidr,2001:db8::/32,direct,no-resolve\n');
  assert.equal(upstreamReads, 1);
});
