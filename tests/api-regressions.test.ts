import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import express from 'express';
import type { AppConfig } from '../src/types/index.js';

const originalDirectory = process.cwd();
let temporaryDirectory: string;
let server: Server | undefined;
let origin: string;
let context: typeof import('../src/server/context.js');

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
  context = await import('../src/server/context.js');
  const { apiRouter } = await import('../src/server/routes/api.js');
  const { subRouter } = await import('../src/server/routes/sub.js');
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
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
});

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test('preview rejects unsupported relay groups with a client error', async () => {
  const config = fixture();
  config.proxyGroups = [{ id: 'chain', name: 'Chain', type: 'relay', proxies: ['Entry', 'Exit'] }];
  context.setAppConfig(config);

  for (const customType of ['mihomo', 'quantumultx']) {
    const result = await post('/api/generate/preview', {
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
  assert.deepEqual((await response.json()).data, []);

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
  const listed = await response.json();
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
  const listed = await response.json();
  assert.equal(listed.data[0].token, refreshed.body.data.token);
});

test('preview provider links use the external HTTPS host and the selected profile token', async () => {
  const config = fixture();
  config.sources = [{ id: 'manual', name: 'Manual', type: 'manual', enabled: true, nodes: [] }];
  config.proxyGroups = [{ id: 'manual-group', name: 'Manual', type: 'select', sources: ['manual'] }];
  context.setAppConfig(config);
  const created = await post('/api/profiles', { name: 'Mihomo' });
  assert.equal(created.status, 200);

  const result = await post('/api/generate/preview', {
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

  const result = await post('/api/generate/preview', {
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
  const profile = {
    id: 'qx-profile',
    name: 'QX',
    token: 'qx-rule-test-token',
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
