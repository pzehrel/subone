import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { serve } from '@hono/node-server';
import type { AppConfig, ProxyNode, SubscriptionProfile, SubscriptionSource } from '../src/types/index';

const originalDirectory = process.cwd();
const originalRoot = process.env.SUBONE_ROOT;
let temporaryDirectory: string;
let server: ReturnType<typeof serve> | undefined;
let origin: string;
let context: typeof import('../src/context');
let auth: typeof import('../src/middlewares/auth');

const consoleHtml = '<!doctype html><html><body>SubOne test console</body></html>';
const consoleScript = 'console.log("SubOne");';

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
  await mkdir(join(temporaryDirectory, 'apps/web/dist/assets'), { recursive: true });
  await writeFile(join(temporaryDirectory, 'apps/web/dist/index.html'), consoleHtml);
  await writeFile(join(temporaryDirectory, 'apps/web/dist/assets/app.js'), consoleScript);
  process.chdir(temporaryDirectory);
  process.env.SUBONE_ROOT = temporaryDirectory;
  context = await import('../src/context');
  auth = await import('../src/middlewares/auth');
  const { createApp } = await import('../src/app');
  const app = createApp();
  server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  origin = `http://127.0.0.1:${address.port}`;
});

beforeEach(() => {
  context.setAppConfig(fixture());
  context.setGlobalNodesCache([]);
  auth.activeSessions.clear();
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

test('authentication preserves public login, both token headers, expiry and logout', async () => {
  const config = fixture();
  config.settings.adminPassword = 'test-password';
  context.setAppConfig(config);

  const status = await fetch(`${origin}/api/auth/status`);
  assert.deepEqual(await status.json(), { success: true, authRequired: true, authenticated: false });

  const denied = await fetch(`${origin}/api/config`);
  assert.equal(denied.status, 401);
  assert.deepEqual(await denied.json(), { success: false, message: '请先登录管理控制台' });
  assert.equal((await post('/api/auth/change-password', { newPassword: 'other' })).status, 401);
  assert.equal((await post('/api/settings/regenerate-sub-token', {})).status, 401);
  assert.equal((await post('/api/auth/login', { password: 'wrong' })).status, 401);

  const login = await fetch(`${origin}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'test-password' }),
  });
  assert.equal(login.status, 200);
  const { token } = await login.json() as { token: string };
  assert.match(token, /^sess_[a-f0-9]{48}$/);

  for (const headers of [{ Authorization: `Bearer ${token}` }, { 'X-Auth-Token': token }]) {
    assert.equal((await fetch(`${origin}/api/config`, { headers })).status, 200);
    const authenticated = await fetch(`${origin}/api/auth/status`, { headers });
    assert.deepEqual(await authenticated.json(), { success: true, authRequired: true, authenticated: true });
  }

  auth.activeSessions.set(token, { createdAt: Date.now() - auth.SESSION_TTL_MS - 1 });
  assert.equal((await fetch(`${origin}/api/config`, { headers: { Authorization: `Bearer ${token}` } })).status, 401);

  const session = auth.createSession();
  assert.equal((await post('/api/auth/logout', {}, { Authorization: `Bearer ${session}` })).status, 200);
  assert.equal((await fetch(`${origin}/api/config`, { headers: { Authorization: `Bearer ${session}` } })).status, 401);
});

test('password changes and token rotation retain their protected API paths', async () => {
  const config = fixture();
  config.settings.adminPassword = 'old-password';
  context.setAppConfig(config);
  const headers = { Authorization: `Bearer ${auth.createSession()}` };

  const rejected = await post('/api/auth/change-password', { oldPassword: 'wrong', newPassword: 'new-password' }, headers);
  assert.equal(rejected.status, 400);
  assert.equal(rejected.body.message, '旧密码验证失败');

  const changed = await post('/api/auth/change-password', { oldPassword: 'old-password', newPassword: ' new-password ' }, headers);
  assert.equal(changed.status, 200);
  assert.equal(context.getAppConfig().settings.adminPassword, 'new-password');
  assert.equal((await post('/api/auth/login', { password: 'new-password' })).status, 200);

  const rotated = await fetch(`${origin}/api/settings/regenerate-sub-token`, { method: 'POST', headers });
  assert.equal(rotated.status, 200);
  const body = await rotated.json() as { success: boolean; subToken: string };
  assert.equal(body.success, true);
  assert.equal(body.subToken, context.getAppConfig().settings.subToken);
  assert.match(body.subToken, /^[a-f0-9]{32}$/);
});

test('administration remains accessible when no password is configured', async () => {
  const response = await fetch(`${origin}/api/auth/status`);
  assert.deepEqual(await response.json(), { success: true, authRequired: false, authenticated: true });
  assert.equal((await fetch(`${origin}/api/config/`)).status, 200);
  assert.equal((await post('/api/auth/login', {})).status, 200);
});

test('nested URL-encoded forms remain accepted alongside JSON requests', async () => {
  const response = await fetch(`${origin}/api/profiles`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    body: new URLSearchParams({
      name: '手机订阅',
      'nodeFilter[mode]': 'selected',
      'nodeFilter[selectedNodeIds][]': 'node-1',
      'selectedGroupIds[]': 'group-1',
    }).toString(),
  });
  assert.equal(response.status, 200);
  const profile = (await readApiResponse<SubscriptionProfile>(response)).data;
  assert.equal(profile.name, '手机订阅');
  assert.deepEqual(profile.nodeFilter, { mode: 'selected', selectedNodeIds: ['node-1'] });
  assert.deepEqual(profile.selectedGroupIds, ['group-1']);
});

test('invalid JSON is rejected before business handlers run', async () => {
  for (const body of ['{"name":', 'null', '"phone"']) {
    const response = await fetch(`${origin}/api/profiles`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    });
    assert.equal(response.status, 400);
  }
  assert.deepEqual(context.getAppConfig().profiles, []);
});

test('the 20 MB body limit accepts imports and rejects oversized fixed and chunked requests', async () => {
  const accepted = await post('/api/profiles', { name: 'Large profile', description: 'x'.repeat(128 * 1024) });
  assert.equal(accepted.status, 200);

  const rejected = await fetch(`${origin}/api/profiles`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Too large', description: 'x'.repeat(20 * 1024 * 1024) }),
  });
  assert.equal(rejected.status, 413);
  await rejected.text();

  const chunkedStatus = await new Promise<number | undefined>((resolve, reject) => {
    const upload = request(`${origin}/api/profiles`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
    }, response => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    upload.on('error', reject);
    upload.write('{"name":"Too large","description":"');
    const chunk = 'x'.repeat(1024 * 1024);
    for (let index = 0; index < 21; index += 1) upload.write(chunk);
    upload.end('"}');
  });
  assert.equal(chunkedStatus, 413);
  assert.equal(context.getAppConfig().profiles?.length, 1);
});

test('CORS preflight remains public and allows existing API methods and headers', async () => {
  const config = fixture();
  config.settings.adminPassword = 'test-password';
  context.setAppConfig(config);

  const response = await fetch(`${origin}/api/sources/phone`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://console.example.test',
      'Access-Control-Request-Method': 'DELETE',
      'Access-Control-Request-Headers': 'authorization,content-type,x-auth-token',
    },
  });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.match(response.headers.get('access-control-allow-methods') || '', /DELETE/);
  assert.match(response.headers.get('access-control-allow-headers') || '', /authorization/);
});

test('the same server serves console assets and SPA routes without replacing API or subscription errors', async () => {
  for (const path of ['/', '/profiles/phone']) {
    const response = await fetch(`${origin}${path}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') || '', /text\/html/);
    assert.equal(await response.text(), consoleHtml);
  }

  const asset = await fetch(`${origin}/assets/app.js`);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get('content-type') || '', /javascript/);
  assert.equal(await asset.text(), consoleScript);

  const head = await fetch(`${origin}/assets/app.js`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');

  for (const path of ['/api/does-not-exist', '/s/invalid-token', '/s/invalid-token/source/phone']) {
    const response = await fetch(`${origin}${path}`);
    assert.equal(response.status, 404);
    assert.equal(await response.text(), '404 Not Found');
    assert.equal(response.headers.get('x-powered-by'), null);
  }
});

test('legacy subscription paths retain silent 404 responses for every method', async () => {
  for (const path of ['/sub', '/sub/', '/sub/legacy/path']) {
    for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
      const response = await fetch(`${origin}${path}`, { method });
      assert.equal(response.status, 404);
      assert.equal(await response.text(), '404 Not Found');
      assert.match(response.headers.get('content-type') || '', /text\/plain/);
      assert.equal(response.headers.get('x-powered-by'), null);
    }
  }
});

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
  config.proxyGroups = [{ id: 'airport-choice', name: 'Airport choice', type: 'select', sources: ['airport'] }];
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
    assert.equal(response.status, 200, await response.clone().text());
    const output = await response.text();
    assert.ok(output.includes('Airport_香港 01'));
    assert.ok(!output.includes('剩余流量'));
    assert.ok(!output.includes('套餐到期'));
  }
  for (const target of ['mihomo', 'loon', 'qx', 'egern']) {
    const response = await fetch(`${origin}/s/info-test/${target}?expand=false`);
    assert.equal(response.status, 200, await response.clone().text());
    const output = await response.text();
    assert.ok(output.includes('Airport_香港 01'));
    assert.doesNotMatch(output, /\/source\/|\/nodes\/qx/);
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
  assert.deepEqual(context.getAppConfig().sources[0], { ...beforeFailure, lastUpdateError: refresh.body.message });

  const restored = await update({ trafficNodeRegex: '', expiryNodeRegex: '' });
  assert.equal(restored.body.data.nodeCount, 3);
  assert.deepEqual(restored.body.data.infoNodes, []);
  assert.equal(restored.body.data.subscriptionInfo, undefined);
});

test('profile subscriptions aggregate only selected enabled upstreams for every client format', async () => {
  const config = fixture();
  const source = (id: string, download: number, enabled = true): SubscriptionSource => ({
    id, name: id, type: 'remote', url: `https://${id}.example.test/sub`, enabled,
    nodes: [{ id: `node-${id}`, name: id, type: 'ss', server: `${id}.example.test`, port: 443, method: 'aes-128-gcm', password: 'test' }],
    subscriptionInfo: { upload: 1024, download, total: 10240, expire: id === 'b' ? 1861920000 : 1893456000 },
  });
  config.sources = [source('a', 2048), source('b', 4096), source('unselected', 50000), source('disabled', 60000, false)];
  config.profiles = [{
    id: 'profile', name: 'Phone', token: 'usage-test', enabled: true,
    nodeFilter: { mode: 'all', sourceIds: ['a', 'b', 'b', 'disabled'] },
  }];
  context.setAppConfig(config);

  for (const target of ['', '/mihomo', '/singbox', '/loon', '/qx', '/egern', '/shadowrocket', '/shadowrocket?format=base64']) {
    const response = await fetch(`${origin}/s/usage-test${target}`);
    assert.equal(response.status, 200, `${target}: ${await response.clone().text()}`);
    assert.equal(response.headers.get('subscription-userinfo'), 'upload=2048; download=6144; total=20480; expire=1861920000', target);
    await response.text();
  }

  const profile = context.getAppConfig().profiles![0];
  profile.nodeFilter.sourceIds = ['b'];
  let response = await fetch(`${origin}/s/usage-test/mihomo`);
  assert.equal(response.headers.get('subscription-userinfo'), 'upload=1024; download=4096; total=10240; expire=1861920000');
  await response.text();
  config.sources[1].subscriptionInfo!.download = 5120;
  response = await fetch(`${origin}/s/usage-test/mihomo`);
  assert.equal(response.headers.get('subscription-userinfo'), 'upload=1024; download=5120; total=10240; expire=1861920000');
  await response.text();

  profile.nodeFilter.sourceIds = [];
  response = await fetch(`${origin}/s/usage-test/mihomo`);
  assert.equal(response.headers.get('subscription-userinfo'), 'upload=3072; download=57168; total=30720; expire=1861920000');
  await response.text();
});

test('profile subscriptions omit fake traffic when upstream metadata is unavailable', async () => {
  const config = fixture();
  config.sources = [{ id: 'manual', name: 'Manual', type: 'manual', enabled: true, nodes: [] }];
  config.profiles = [{ id: 'profile', name: 'Phone', token: 'no-usage', enabled: true, nodeFilter: { mode: 'all' } }];
  context.setAppConfig(config);
  for (const target of ['mihomo', 'singbox', 'loon', 'qx', 'egern', 'shadowrocket']) {
    const response = await fetch(`${origin}/s/no-usage/${target}`);
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(response.headers.get('subscription-userinfo'), null);
    await response.text();
  }
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

test('non-expanded preview does not create managed provider links behind an external HTTPS host', async () => {
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
    expandNodes: false,
  }, {
    'X-Forwarded-Proto': 'https',
    'X-Forwarded-Host': 'subscriptions.example.test',
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.success, true);
  assert.doesNotMatch(result.body.data, /subscriptions\.example\.test|\/source\/manual|proxy-providers/);
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

test('QuanX source creation, format changes and refresh preserve the selected parser', async t => {
  const userAgents: string[] = [];
  const upstream = createServer((request, response) => {
    const ua = request.headers['user-agent'] || '';
    userAgents.push(ua);
    if (ua.includes('Quantumult')) {
      response.end('shadowsocks=quanx.example.test:443, method=aes-128-gcm, password=test-secret, tag=QuanX node');
    } else {
      response.end('ss://' + Buffer.from('aes-128-gcm:test-secret').toString('base64') + '@auto.example.test:443#Auto');
    }
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(() => new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve())));
  const address = upstream.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/subscription`;
  const created = await post<SubscriptionSource>('/api/sources', { name: 'QuanX upstream', url, type: 'auto' });
  assert.equal(created.status, 200);
  assert.equal(created.body.data.nodes?.[0].name, 'Auto');
  const id = created.body.data.id;
  const updatedResponse = await fetch(`${origin}/api/sources/${id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'quantumultx' }),
  });
  const updated = await readApiResponse<SubscriptionSource>(updatedResponse);
  assert.equal(updatedResponse.status, 200);
  assert.equal(updated.data.type, 'quantumultx');
  assert.equal(updated.data.url, url);
  assert.equal(updated.data.nodes?.[0].name, 'QuanX node');
  assert.equal(updated.data.nodes?.[0].server, 'quanx.example.test');
  assert.match(userAgents.at(-1) || '', /Quantumult/);
  const refreshed = await post(`/api/sources/${id}/refresh`, {});
  assert.equal(refreshed.status, 200);
  assert.equal(context.appConfig.sources[0].nodes?.[0].name, 'QuanX node');
  assert.equal(context.appConfig.sources[0].type, 'quantumultx');
});
