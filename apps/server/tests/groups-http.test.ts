import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import yaml from 'js-yaml';

let directory: string;
let child: ChildProcess;
let origin: string;
let upstreamOrigin: string;
const upstream = createServer((_request, response) => response.end(yaml.dump({ proxies: [
  { name: 'First member', type: 'ss', server: 'first.example', port: 443, cipher: 'aes-128-gcm', password: 'secret' },
  { name: 'Second member', type: 'ss', server: 'second.example', port: 443, cipher: 'aes-128-gcm', password: 'secret' },
] })));

async function startApp() {
  child = spawn(process.execPath, ['--import', 'tsx', join(__dirname, 'helpers/http-server.ts')], { env: { ...process.env, SUBONE_ROOT: directory }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let errors = '';
  child.stderr?.on('data', chunk => { errors += chunk; });
  const message = await Promise.race([once(child, 'message'), once(child, 'exit').then(([code]) => { throw new Error(`Server exited ${code}: ${errors}`); })]);
  origin = `http://127.0.0.1:${message[0].port}`;
}
async function stopApp() { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; }
async function restart() { await stopApp(); await startApp(); }
async function api(path: string, method = 'GET', value?: unknown) {
  const response = await fetch(`${origin}/api${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: value === undefined ? undefined : JSON.stringify(value) });
  return { status: response.status, ...await response.json() as any };
}
async function groups() { return (await api('/groups')).data; }

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'subone-groups-http-'));
  await writeFile(join(directory, 'config.json'), JSON.stringify({ port: 3456, adminPassword: '' }));
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const address = upstream.address(); assert.ok(address && typeof address !== 'string');
  upstreamOrigin = `http://127.0.0.1:${address.port}`;
  await startApp();
});
after(async () => { await stopApp(); await new Promise<void>(resolve => upstream.close(() => resolve())); await rm(directory, { recursive: true, force: true }); });

test('malformed structured group replacement fails without changing saved groups', async () => {
  assert.equal((await api('/groups', 'POST', { name: 'Keep saved group', type: 'select', proxies: ['DIRECT'] })).success, true);
  const before = await groups();
  const rejected = await api('/groups/batch-import', 'POST', { text: 'proxy-groups:\n  - name: [unterminated', replaceAll: true });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.success, false);
  assert.ok(rejected.message);
  assert.deepEqual(await groups(), before);
  await restart();
  assert.deepEqual(await groups(), before);
});

test('invalid group shapes, types and fields reject create, edit and structured replacement atomically', async () => {
  const saved = (await api('/groups', 'POST', { name: 'Validated group', type: 'select', proxies: ['DIRECT'] })).data;
  const before = await groups();
  const invalidFields = [
    { name: 42 }, { name: ' ' }, { type: 'unknown' }, { proxies: 'DIRECT' },
    { proxies: [false] }, { sources: 'source-id' }, { use: [1] }, { filter: '[' },
    { filter: false }, { tolerance: -1 }, { interval: '300' }, { url: false },
    { includeAll: 'false' }, { lazy: 1 }, { hidden: 'true' }, { icon: 1 }, { strategy: 'random' },
    { proxies: null }, { type: null }, { includeAll: null },
  ];
  for (const invalid of invalidFields) {
    const value = { name: 'Invalid group', type: 'select', ...invalid };
    for (const [path, method, body] of [
      ['/groups', 'POST', value],
      [`/groups/${saved.id}`, 'PUT', invalid],
      ['/groups/batch-import', 'POST', { text: yaml.dump({ 'proxy-groups': [value] }), replaceAll: true }],
    ] as const) {
      const rejected = await api(path, method, body);
      assert.equal(rejected.status, 400, `${method} ${path}: ${JSON.stringify(invalid)}`);
      assert.equal(rejected.success, false);
      assert.ok(rejected.message);
      assert.deepEqual(await groups(), before);
    }
  }
  for (const text of ['proxy-groups: wrong-shape', 'proxy-groups:\n  - just-a-name', '{"proxy-groups": [', 'unrelated: []', 'proxy-groups:', 'proxy-groups:wrong-shape']) {
    const rejected = await api('/groups/batch-import', 'POST', { text, replaceAll: true });
    assert.equal(rejected.status, 400, text);
    assert.equal(rejected.success, false);
    assert.deepEqual(await groups(), before);
  }
  await restart();
  assert.deepEqual(await groups(), before);
});

test('either source mount alias can explicitly clear mounts while unrelated edits preserve unavailable selections', async () => {
  const created = await api('/groups', 'POST', { name: 'Repairable group', type: 'select', proxies: ['node:missing-id', 'Missing outbound'], sources: ['missing-source-id'], filter: 'HK' });
  assert.equal(created.success, true, created.message);
  assert.deepEqual(created.data.sources, ['missing-source-id']);
  assert.deepEqual(created.data.use, ['missing-source-id']);
  const renamed = await api(`/groups/${created.data.id}`, 'PUT', { name: 'Repair later' });
  assert.deepEqual(renamed.data.proxies, ['node:missing-id', 'Missing outbound']);
  assert.deepEqual(renamed.data.sources, ['missing-source-id']);
  const clearedUse = await api(`/groups/${created.data.id}`, 'PUT', { use: [], filter: '' });
  assert.equal(clearedUse.success, true, clearedUse.message);
  assert.deepEqual(clearedUse.data.sources, []);
  assert.deepEqual(clearedUse.data.use, []);
  assert.equal(clearedUse.data.filter, undefined);
  assert.deepEqual(clearedUse.data.proxies, ['node:missing-id', 'Missing outbound']);
  const remounted = await api(`/groups/${created.data.id}`, 'PUT', { use: ['other-missing-source'] });
  assert.deepEqual(remounted.data.sources, ['other-missing-source']);
  assert.deepEqual(remounted.data.use, ['other-missing-source']);
  const clearedSources = await api(`/groups/${created.data.id}`, 'PUT', { sources: [], proxies: [] });
  assert.deepEqual(clearedSources.data.sources, []);
  assert.deepEqual(clearedSources.data.use, []);
  assert.deepEqual(clearedSources.data.proxies, []);
  const before = await groups();
  await restart();
  assert.deepEqual(await groups(), before);
});

test('only an explicit empty structured replacement clears the group collection', async () => {
  const before = await groups();
  for (const text of ['[]', 'proxy-groups: []']) {
    const rejected = await api('/groups/batch-import', 'POST', { text });
    assert.equal(rejected.status, 400);
    assert.deepEqual(await groups(), before);
  }
  for (const text of ['   ', '# no groups', '[Proxy Group]']) {
    const rejected = await api('/groups/batch-import', 'POST', { text, replaceAll: true });
    assert.equal(rejected.status, 400);
    assert.deepEqual(await groups(), before);
  }
  for (const text of ['proxy-groups: []', '[]']) {
    const replaced = await api('/groups/batch-import', 'POST', { text, replaceAll: true });
    assert.equal(replaced.success, true, replaced.message);
    assert.equal(replaced.count, 0);
    assert.deepEqual(await groups(), []);
    await restart();
    assert.deepEqual(await groups(), []);
  }
});

test('YAML roundtrip preserves supported fields, stable node and nested group identities, and Relay order', async () => {
  const added = await api('/sources', 'POST', { name: 'Group source', url: `${upstreamOrigin}/groups` });
  assert.equal(added.success, true, added.message);
  const source = added.data;
  const firstToken = `node:${source.nodes[0].id}`;
  const secondToken = `node:${source.nodes[1].id}`;
  const child = (await api('/groups', 'POST', { name: 'Nested child', type: 'select', proxies: [firstToken] })).data;
  const parent = (await api('/groups', 'POST', { name: 'Nested parent', type: 'select', proxies: [`group:${child.id}`, secondToken, 'DIRECT'] })).data;
  const relay = (await api('/groups', 'POST', { name: 'Ordered Relay', type: 'relay', proxies: [secondToken, firstToken] })).data;
  const values = [
    { id: child.id, name: 'Edited child', type: 'url-test', proxies: [firstToken], sources: [source.id], use: [source.id], filter: '(?i)first', url: 'https://probe.example/204', tolerance: 0, interval: 0, 'include-all': false, strategy: 'sticky-sessions', lazy: false, hidden: true, icon: 'https://icon.example/group.png', isCountryGroup: true },
    { id: parent.id, name: parent.name, type: 'select', proxies: [`group:${child.id}`, secondToken, 'DIRECT'] },
    { id: relay.id, name: relay.name, type: 'relay', proxies: [firstToken, secondToken, `group:${child.id}`] },
  ];
  const replaced = await api('/groups/batch-import', 'POST', { text: yaml.dump({ 'proxy-groups': values }), replaceAll: true });
  assert.equal(replaced.success, true, replaced.message);
  assert.deepEqual(replaced.data[0], { id: child.id, name: 'Edited child', type: 'urltest', proxies: [firstToken], sources: [source.id], use: [source.id], filter: '(?i)first', url: 'https://probe.example/204', tolerance: 0, interval: 0, includeAll: false, strategy: 'sticky-sessions', lazy: false, hidden: true, icon: 'https://icon.example/group.png', isCountryGroup: true });
  assert.equal(replaced.data[1].id, parent.id);
  assert.deepEqual(replaced.data[1].proxies, [`group:${child.id}`, secondToken, 'DIRECT']);
  assert.deepEqual(replaced.data[2].proxies, [firstToken, secondToken, `group:${child.id}`]);
  const roundtripped = await api('/groups/batch-import', 'POST', { text: yaml.dump({ 'proxy-groups': replaced.data }), replaceAll: true });
  assert.deepEqual(roundtripped.data, replaced.data);
  await restart();
  assert.deepEqual(await groups(), replaced.data);

  assert.equal((await api(`/nodes/${source.nodes[0].id}`, 'PUT', { name: 'Local first' })).success, true);
  assert.equal((await api(`/sources/${source.id}`, 'PUT', { name: 'Renamed source' })).success, true);
  assert.deepEqual((await groups())[0].sources, [source.id]);
  assert.deepEqual((await groups())[0].proxies, [firstToken]);
  const template = (await api('/templates', 'POST', { name: 'Group output', type: 'mihomo', content: 'proxies: []\nproxy-groups: []\nrules: []\n' })).data;
  const rule = (await api('/rules/unified', 'POST', { name: 'Group output rule', kind: 'local', type: 'DOMAIN', payload: 'group.example', outbound: 'DIRECT', enabled: true })).data;
  const profile = (await api('/profiles', 'POST', { name: 'Group output', nodeFilter: { mode: 'all', sourceIds: [source.id] }, selectedGroupIds: [parent.id], selectedRuleIds: [rule.id], templates: { mihomo: template.id } })).data;
  const preview = await api('/generate/preview', 'POST', { profileId: profile.id, customType: 'mihomo', expandNodes: true });
  assert.equal(preview.success, true, preview.message);
  const response = await fetch(`${origin}/s/${profile.token}/mihomo?expand=true`);
  assert.equal(response.status, 200);
  const output = await response.text();
  const generated = yaml.load(output) as any;
  assert.deepEqual(generated['proxy-groups'].find((group: any) => group.name === 'Nested parent').proxies, ['Edited child', 'Second member', 'DIRECT']);
  assert.ok(generated['proxy-groups'].find((group: any) => group.name === 'Edited child').proxies.includes('Local first'));
  assert.equal(output.includes('node:'), false);
  assert.equal(output.includes('group:'), false);
  assert.deepEqual(yaml.load(preview.data), generated);
});

test('declared YAML group identities must be nonempty and unique across the saved collection', async () => {
  const saved = (await api('/groups', 'POST', { name: 'Identity guard', type: 'select', proxies: ['DIRECT'] })).data;
  const before = await groups();
  const replacements = [
    [{ id: 1, name: 'Invalid ID', type: 'select' }],
    [{ id: '', name: 'Blank ID', type: 'select' }],
    [{ id: '   ', name: 'Blank ID', type: 'select' }],
    [{ id: saved.id, name: 'Duplicate one', type: 'select' }, { id: saved.id, name: 'Duplicate two', type: 'select' }],
  ];
  for (const values of replacements) {
    const result = await api('/groups/batch-import', 'POST', { text: yaml.dump({ 'proxy-groups': values }), replaceAll: true });
    assert.equal(result.status, 400, JSON.stringify(values));
    assert.equal(result.success, false);
    assert.deepEqual(await groups(), before);
  }
  const collision = await api('/groups/batch-import', 'POST', { text: yaml.dump({ 'proxy-groups': [{ id: saved.id, name: 'Collision', type: 'select' }] }) });
  assert.equal(collision.status, 400);
  assert.deepEqual(await groups(), before);
  const updated = await api(`/groups/${saved.id}`, 'PUT', { id: 'different-id', name: 'Same stable identity' });
  assert.equal(updated.data.id, saved.id);
  await restart();
  assert.equal((await groups()).find((group: any) => group.name === 'Same stable identity').id, saved.id);
});

test('structured YAML flow collections and supported Loon and simple-list imports keep their intended formats', async () => {
  for (const text of ['[{name: Flow group, type: select, proxies: [DIRECT]}]', '{proxy-groups: [{name: Flow group, type: select, proxies: [DIRECT]}]}']) {
    const result = await api('/groups/batch-import', 'POST', { text, replaceAll: true });
    assert.equal(result.success, true, result.message);
    assert.equal(result.data.length, 1);
    assert.equal(result.data[0].name, 'Flow group');
    assert.deepEqual(result.data[0].proxies, ['DIRECT']);
  }
  const cleared = await api('/groups/batch-import', 'POST', { text: '{proxy-groups: []}', replaceAll: true });
  assert.equal(cleared.success, true, cleared.message);
  assert.deepEqual(cleared.data, []);
  const loon = await api('/groups/batch-import', 'POST', { text: '[Proxy Group]\nLoon group = select,DIRECT,REJECT', replaceAll: true });
  assert.equal(loon.success, true, loon.message);
  assert.equal(loon.data[0].name, 'Loon group');
  assert.deepEqual(loon.data[0].proxies, ['DIRECT', 'REJECT']);
  const simple = await api('/groups/batch-import', 'POST', { text: 'Simple group\nOther group', replaceAll: true });
  assert.equal(simple.success, true, simple.message);
  assert.deepEqual(simple.data.map((group: any) => group.name), ['Simple group', 'Other group']);
});

test('create, edit, YAML replacement and deletion storage failures report failure and publish no changes', async () => {
  const saved = (await api('/groups', 'POST', { name: 'Durable group', type: 'select', proxies: ['DIRECT'] })).data;
  assert.equal((await api('/groups', 'POST', { name: 'Keep reference', type: 'select', proxies: [`group:${saved.id}`] })).success, true);
  const before = (await api('/config')).data;
  const path = join(directory, 'data', 'subone_data.json');
  const persisted = await readFile(path, 'utf8');
  await chmod(join(directory, 'data'), 0o500);
  try {
    for (const [path, method, value] of [
      ['/groups', 'POST', { name: 'Unsaved new group', type: 'select' }],
      [`/groups/${saved.id}`, 'PUT', { name: 'Unsaved rename', proxies: ['REJECT'] }],
      ['/groups/batch-import', 'POST', { text: 'proxy-groups:\n  - name: Unsaved replacement\n    type: select\n', replaceAll: true }],
      [`/groups/${saved.id}`, 'DELETE', undefined],
    ] as const) {
      const result = await api(path, method, value);
      assert.equal(result.status, 500, `${method} ${path}`);
      assert.equal(result.success, false);
      assert.match(result.message, /保存/);
      assert.deepEqual((await api('/config')).data, before);
    }
    assert.equal(await readFile(path, 'utf8'), persisted);
  } finally { await chmod(join(directory, 'data'), 0o700); }
  await restart();
  assert.deepEqual((await api('/config')).data, before);
});

test('acknowledged group deletion persists and keeps unrelated groups, rules and templates', async () => {
  const saved = (await api('/groups', 'POST', { name: 'Delete only this group', type: 'select', proxies: ['DIRECT'] })).data;
  const before = (await api('/config')).data;
  const result = await api(`/groups/${saved.id}`, 'DELETE');
  assert.equal(result.success, true, result.message);
  assert.deepEqual(await groups(), before.proxyGroups.filter((group: any) => group.id !== saved.id));
  await restart();
  const after = (await api('/config')).data;
  assert.deepEqual(after.proxyGroups, before.proxyGroups.filter((group: any) => group.id !== saved.id));
  assert.deepEqual(after.rulesList, before.rulesList);
  assert.deepEqual(after.templates, before.templates);
});

test('YAML group rename keeps existing rule and template references bound to the retained identity', async () => {
  const source = (await api('/sources', 'POST', { name: 'YAML rename source', url: `${upstreamOrigin}/rename` })).data;
  const child = (await api('/groups', 'POST', { name: 'Before YAML rename', type: 'select', proxies: [`node:${source.nodes[0].id}`] })).data;
  const parent = (await api('/groups', 'POST', { name: 'YAML rename parent', type: 'select', proxies: [child.name] })).data;
  const content = yaml.dump({ proxies: [], 'proxy-groups': [{ name: 'Template selector', type: 'select', proxies: [child.name] }], rules: [] });
  const template = (await api('/templates', 'POST', { name: 'YAML rename template', type: 'mihomo', content })).data;
  const rule = (await api('/rules/unified', 'POST', { name: 'YAML rename rule', kind: 'local', type: 'DOMAIN', payload: 'yaml-rename.example', outbound: child.name, enabled: true })).data;
  const profile = (await api('/profiles', 'POST', { name: 'YAML rename profile', nodeFilter: { mode: 'all', sourceIds: [source.id] }, selectedGroupIds: [parent.id], selectedRuleIds: [rule.id], templates: { mihomo: template.id } })).data;
  const collection = (await groups()).map((group: any) => group.id === child.id ? { ...group, name: 'After YAML rename' } : group);
  const result = await api('/groups/batch-import', 'POST', { text: yaml.dump({ 'proxy-groups': collection }), replaceAll: true });
  assert.equal(result.success, true, result.message);
  assert.equal((await api('/rules/unified')).data.find((item: any) => item.id === rule.id).outbound, 'After YAML rename');
  const storedTemplate = (await api('/templates')).data.find((item: any) => item.id === template.id);
  assert.equal(storedTemplate.content, content);
  assert.deepEqual(storedTemplate.connectionReferences, template.connectionReferences);
  await restart();
  const preview = await api('/generate/preview', 'POST', { profileId: profile.id, customType: 'mihomo', expandNodes: true });
  assert.equal(preview.success, true, preview.message);
  const actual = await fetch(`${origin}/s/${profile.token}/mihomo?expand=true`);
  assert.equal(actual.status, 200);
  const output = yaml.load(await actual.text()) as any;
  assert.deepEqual(output['proxy-groups'].find((group: any) => group.name === 'Template selector').proxies, ['After YAML rename']);
  assert.deepEqual(output['proxy-groups'].find((group: any) => group.name === parent.name).proxies, ['After YAML rename']);
  assert.ok(output.rules.includes('DOMAIN,yaml-rename.example,After YAML rename'));
  assert.deepEqual(yaml.load(preview.data), output);
});

test('simultaneous YAML renames follow each original group identity without cascading through another name', async () => {
  const first = (await api('/groups', 'POST', { name: 'Batch rename A', type: 'select', proxies: ['DIRECT'] })).data;
  const second = (await api('/groups', 'POST', { name: 'Batch rename B', type: 'select', proxies: ['REJECT'] })).data;
  const firstRule = (await api('/rules/unified', 'POST', { name: 'First rename rule', kind: 'local', type: 'DOMAIN', payload: 'first-rename.example', outbound: first.name, enabled: true })).data;
  const secondRule = (await api('/rules/unified', 'POST', { name: 'Second rename rule', kind: 'local', type: 'DOMAIN', payload: 'second-rename.example', outbound: second.name, enabled: true })).data;
  const collection = (await groups()).map((group: any) => group.id === first.id ? { ...group, name: second.name } : group.id === second.id ? { ...group, name: 'Batch rename C' } : group);
  const result = await api('/groups/batch-import', 'POST', { text: yaml.dump({ 'proxy-groups': collection }), replaceAll: true });
  assert.equal(result.success, true, result.message);
  for (const restarted of [false, true]) {
    if (restarted) await restart();
    const rules = (await api('/rules/unified')).data;
    assert.equal(rules.find((rule: any) => rule.id === firstRule.id).outbound, 'Batch rename B');
    assert.equal(rules.find((rule: any) => rule.id === secondRule.id).outbound, 'Batch rename C');
  }
});
