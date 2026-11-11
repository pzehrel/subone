import { httpApp } from './helpers/http-app';
import assert from 'node:assert/strict';
import yaml from 'js-yaml';
import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';

const app = httpApp('subone-source-naming-');
const { api } = app;

let upstreamOrigin: string;
let body = '';
let beforeResponse: (() => Promise<void>) | undefined;
const upstream = createServer(async (_request, response) => {
  await beforeResponse?.();
  response.end(body);
});

const valid = '# upstream evidence\nproxies:\n  - { name: First, type: ss, server: one.example, port: 443, cipher: aes-128-gcm, password: secret }\ndns:\n  nameserver: [https://dns.example/dns-query, tls://ordinary.example]\ncustom: preserved\n';
before(async () => {
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const address = upstream.address();
  assert.ok(address && typeof address !== 'string');
  upstreamOrigin = `http://127.0.0.1:${address.port}`;
});
after(async () => {
  await new Promise<void>(resolve => upstream.close(() => resolve()));
});

test('source naming fields persist through remote, paste, file and restart, and invalid edits preserve the saved configuration', async () => {
  body = valid;
  const added = await api('/sources', 'POST', { name: 'A', url: upstreamOrigin, extractRegex: 'x(?<multiplier>\\d+(?:\\.\\d+)?)', nameTemplate: '{region} {region_index} {multiplier}x' });
  assert.equal(added.success, true, added.message);
  assert.equal(added.data.extractRegex, 'x(?<multiplier>\\d+(?:\\.\\d+)?)');
  assert.equal(added.data.nameTemplate, '{region} {region_index} {multiplier}x');
  const id = added.data.id;
  for (const updates of [
    { extractRegex: '(' }, { extractRegex: '(?<region>.*)' }, { nameTemplate: '{missing}' },
    { nameTemplate: '{' }, { nameTemplate: '{}' }, { nameTemplate: '}' }, { extractRegex: '' },
  ]) {
    const rejected = await api(`/sources/${id}`, 'PUT', updates);
    assert.equal(rejected.status, 400, JSON.stringify(updates));
    assert.deepEqual((await api('/sources')).data.find((source: any) => source.id === id), added.data);
  }
  const cleared = await api(`/sources/${id}`, 'PUT', { extractRegex: '', nameTemplate: '' });
  assert.equal(cleared.success, true, cleared.message);
  assert.equal(cleared.data.nameTemplate, '');
  const pasted = await api('/sources', 'POST', { name: 'Pasted', acquisition: 'manual', content: valid });
  assert.equal(pasted.data.extractRegex, '');
  assert.equal(pasted.data.nameTemplate, '{upstream_name}_{region} {region_index}');
  const file = await api('/sources', 'POST', { name: 'File', acquisition: 'manual', contentFile: { name: 'nodes.yaml', base64: Buffer.from(valid).toString('base64') }, extractRegex: 'no-match(?<zero>0)', nameTemplate: '{{{region}}} {zero}' });
  assert.equal(file.success, true, file.message);
  await app.restart();
  const sources = (await api('/sources')).data;
  assert.equal(sources.find((source: any) => source.id === id).nameTemplate, '');
  assert.equal(sources.find((source: any) => source.id === file.data.id).nameTemplate, '{{{region}}} {zero}');
});

function template(target: string): string {
  if (target === 'singbox') return JSON.stringify({ log: { disabled: true }, outbounds: [{ type: 'direct', tag: 'DIRECT' }], route: { final: 'First import choice' } });
  if (target === 'mihomo') return yaml.dump({ 'mixed-port': 0, 'external-controller': '', mode: 'rule', proxies: [], 'proxy-groups': [], rules: ['MATCH,First import choice'] });
  if (target === 'egern') return yaml.dump({ proxies: [], policy_groups: [], rules: [{ default: { policy: 'First import choice' } }] });
  if (target === 'quantumultx') return '[general]\n[dns]\n[server_local]\n[server_remote]\n[policy]\n[filter_local]\nfinal, First import choice\n';
  return '[General]\ndns-server = system\n[Proxy]\n[Remote Proxy]\n[Proxy Group]\n[Rule]\nFINAL,First import choice\n';
}

function inspect(target: string, content: string) {
  if (target === 'singbox') {
    const doc = JSON.parse(content);
    return { nodes: doc.outbounds.filter((entry: any) => entry.server).map((entry: any) => entry.tag), groups: doc.outbounds.filter((entry: any) => ['selector', 'urltest'].includes(entry.type) && entry.tag !== 'GLOBAL').map((entry: any) => entry.tag), resources: 0 };
  }
  if (target === 'mihomo') {
    const doc: any = yaml.load(content);
    return { nodes: doc.proxies.map((entry: any) => entry.name), groups: doc['proxy-groups'].map((entry: any) => entry.name), resources: Object.keys(doc['proxy-providers'] || {}).length };
  }
  if (target === 'egern') {
    const doc: any = yaml.load(content);
    const values = (entries: any[]) => entries.map(entry => Object.values(entry)[0] as any);
    return { nodes: values(doc.proxies).map(entry => entry.name), groups: values(doc.policy_groups).map(entry => entry.name), resources: values(doc.policy_groups).reduce((sum, entry) => sum + (entry.urls?.length || 0), 0) };
  }
  const sectionLines = (name: string) => {
    let section = '';
    return content.split('\n').filter(line => {
      if (line.startsWith('[')) { section = line.trim(); return false; }
      return section === name && line.trim() && !/^\s*[#;]/.test(line);
    });
  };
  const qx = target === 'quantumultx';
  return {
    nodes: sectionLines(qx ? '[server_local]' : '[Proxy]').map(line => qx ? line.match(/tag=([^\n]+)$/)![1] : line.split('=')[0].trim()),
    groups: sectionLines(qx ? '[policy]' : '[Proxy Group]').map(line => qx ? line.split('=')[1].split(',')[0].trim() : line.split('=')[0].trim()),
    resources: sectionLines(qx ? '[server_remote]' : '[Remote Proxy]').length,
  };
}

test('the same downstream names appear in preview and all six complete downloads, without changing naming inputs or identities', async () => {
  const node = (name: string, server: string) => ({ name, type: 'trojan', server, port: 443, password: 'fixture-password' });
  const first = await api('/sources', 'POST', { name: 'Airport A', acquisition: 'manual', content: yaml.dump({ proxies: [node('日本01', '192.0.2.10')] }) });
  const a = first.data;
  const local = await api(`/nodes/${a.nodes[0].id}`, 'PUT', { name: '大阪专线' });
  assert.equal(local.success, true);
  const second = await api('/sources', 'POST', { name: 'Airport B', acquisition: 'manual', content: yaml.dump({ proxies: [node('东京01 x0.5', '192.0.2.11'), node('大阪09 x0', '192.0.2.12'), node('香港01 x2', '192.0.2.13')] }), extractRegex: 'X(?<multiplier>[0-9.]+)', nameTemplate: '{region_emoji} {region} {region_index}' });
  const b = second.data;
  const group = (await api('/groups', 'POST', { name: 'First import choice', type: 'select', sources: [a.id, b.id], proxies: ['node:' + a.nodes[0].id] })).data;
  const profiles: any[] = [];
  for (const target of ['singbox', 'mihomo', 'loon', 'quantumultx', 'egern', 'shadowrocket']) {
    const tpl = (await api('/templates', 'POST', { name: target + ' naming', type: target, content: template(target) })).data;
    const profile = (await api('/profiles', 'POST', { name: 'Named downstream', nodeFilter: { mode: 'all', sourceIds: [a.id, b.id], includeRegex: '大阪|东京|香港' }, selectedGroupIds: [group.id], selectedRuleIds: ['no-rules'], templates: { [target]: tpl.id } })).data;
    profiles.push({ target, profile });
    const response = await fetch(`${app.origin}/s/${profile.token}/${target}`);
    const output = await response.text();
    assert.equal(response.status, 200, output);
    assert.deepEqual(inspect(target, output).nodes, ['Airport A_大阪 01', '🇯🇵 东京 01', '🇯🇵 大阪 02', '🇭🇰 香港 01'], target);
    const preview = await api('/generate/preview', 'POST', { profileId: profile.id, customType: target });
    assert.equal(preview.data, output, preview.message);
    assert.match(output, /Airport A_大阪 01/);
    assert.doesNotMatch(output, /大阪专线|东京01 x0\.5|大阪09 x0|香港01 x2/);
    if (target === 'singbox') assert.ok(JSON.parse(output).outbounds.find((entry: any) => entry.tag === group.name).outbounds.includes('Airport A_大阪 01'));
    if (target === 'mihomo') assert.ok((yaml.load(output) as any)['proxy-groups'].find((entry: any) => entry.name === group.name).proxies.includes('Airport A_大阪 01'));
  }
  const saved = (await api('/sources')).data;
  assert.equal(saved.find((source: any) => source.id === a.id).nodes[0].name, '大阪专线');
  assert.equal(saved.find((source: any) => source.id === b.id).nodes[1].name, '大阪09 x0');
  const renamed = await api(`/sources/${a.id}`, 'PUT', { name: 'Renamed A', nameTemplate: '{region_code} {region} {region_index}' });
  assert.equal(renamed.success, true, renamed.message);
  assert.equal(renamed.data.nodes[0].id, a.nodes[0].id);
  await app.restart();
  const { target, profile } = profiles[1];
  const restored = await fetch(`${app.origin}/s/${profile.token}/${target}`).then(response => response.text());
  assert.deepEqual(inspect(target, restored).nodes, ['JP 大阪 01', '🇯🇵 东京 01', '🇯🇵 大阪 02', '🇭🇰 香港 01']);
});

test('capture text, literal braces, missing values and empty templates preserve their distinct naming behavior immediately', async () => {
  const nodes = ['大阪 x0', '大阪 X0.5', '大阪 no multiplier', '大阪 x2', 'Unknown x4'].map((name, index) => ({ name, type: 'trojan', server: '192.0.2.' + (30 + index), port: 443, password: 'password' }));
  const saved = await api('/sources', 'POST', { name: 'Captured', acquisition: 'manual', content: yaml.dump({ proxies: nodes }), extractRegex: 'x(?<multiplier>[0-9.]+)', nameTemplate: '{{{region}}} {region_index} {multiplier}x' });
  assert.equal(saved.success, true, saved.message);
  const source = saved.data;
  const group = (await api('/groups', 'POST', { name: 'Captured nodes', type: 'select', sources: [source.id] })).data;
  const tpl = (await api('/templates', 'POST', { name: 'Capture template', type: 'mihomo', content: yaml.dump({ proxies: [], 'proxy-groups': [], rules: ['MATCH,DIRECT'] }) })).data;
  const profile = (await api('/profiles', 'POST', { templates: { mihomo: tpl.id }, name: 'Captures', nodeFilter: { mode: 'all', sourceIds: [source.id] }, selectedGroupIds: [group.id], selectedRuleIds: ['no-rules'] })).data;
  const download = async () => {
    const response = await fetch(`${app.origin}/s/${profile.token}/mihomo`);
    const output = await response.text();
    assert.equal(response.status, 200, output);
    return inspect('mihomo', output).nodes;
  };
  assert.deepEqual(await download(), ['{大阪} 01 0x', '{大阪} 02 0.5x', '大阪 no multiplier', '{大阪} 04 2x', 'Unknown x4']);
  assert.equal((await api(`/sources/${source.id}`, 'PUT', { nameTemplate: '' })).success, true);
  assert.deepEqual(await download(), nodes.map(node => node.name));
  assert.equal((await api(`/sources/${source.id}`, 'PUT', { nameTemplate: '{region} {region_index}' })).success, true);
  assert.deepEqual(await download(), ['大阪 01', '大阪 02', '大阪 03', '大阪 04', 'Unknown x4']);
  assert.equal((await api(`/sources/${source.id}`, 'PUT', { content: 'invalid subscription' })).success, false);
  assert.deepEqual(await download(), ['大阪 01', '大阪 02', '大阪 03', '大阪 04', 'Unknown x4']);
  assert.deepEqual((await api('/sources')).data.find((entry: any) => entry.id === source.id).nodes.map((entry: any) => entry.id), source.nodes.map((entry: any) => entry.id));
});

test('refresh preserves a naming pair and local settings saved while awaiting the upstream', async () => {
  body = valid;
  const added = await api('/sources', 'POST', { name: 'Original', url: upstreamOrigin, nameTemplate: 'old' });
  assert.equal(added.success, true, added.message);
  const { id, nodes: [first] } = added.data;
  const gate = new EventEmitter();
  const requested = once(gate, 'requested');
  beforeResponse = async () => { gate.emit('requested'); await once(gate, 'release'); };
  body = valid.replace('name: First', 'name: New Osaka');
  const refresh = api('/sources/' + id + '/refresh', 'POST');
  try {
    await requested;
    const updated = await api('/sources/' + id, 'PUT', { name: 'Renamed', extractRegex: '(?<value>local)', nameTemplate: '{value} {region_index}' });
    assert.equal(updated.success, true, updated.message);
    assert.equal((await api('/nodes/' + first.id, 'PUT', { name: 'Tokyo local' })).success, true);
  } finally {
    beforeResponse = undefined;
    gate.emit('release');
  }
  const refreshed = await refresh;
  assert.equal(refreshed.success, true, refreshed.message);
  const current = (await api('/sources')).data.find((entry: any) => entry.id === id);
  assert.equal(current.nameTemplate, '{value} {region_index}');
  assert.equal(current.extractRegex, '(?<value>local)');
  assert.equal(current.name, 'Renamed');
  assert.deepEqual([current.nodes[0].id, current.nodes[0].name, current.nodes[0].sourceName, current.nodes[0].originalName], [first.id, 'Tokyo local', 'Renamed', 'New Osaka']);
  assert.equal((await api('/sources/' + id + '/raw')).data.content, body);
});
