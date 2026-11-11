import assert from 'node:assert/strict';
import yaml from 'js-yaml';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

let directory: string;
let child: ChildProcess;
let origin: string;
let upstreamOrigin: string;
const bodies = new Map<string, string>();
const upstream = createServer((request, response) => response.end(bodies.get(request.url || '/') || 'proxies: []'));
async function api(path: string, method = 'GET', value?: unknown) {
  const response = await fetch(`${origin}/api${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: value === undefined ? undefined : JSON.stringify(value) });
  return { status: response.status, ...(await response.json() as any) };
}
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'subone-ordinary-routing-http-'));
  await writeFile(join(directory, 'config.json'), JSON.stringify({ port: 3456, adminPassword: '' }));
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const address = upstream.address(); assert.ok(address && typeof address !== 'string'); upstreamOrigin = `http://127.0.0.1:${address.port}`;
  child = spawn(process.execPath, ['--import', 'tsx', join(__dirname, 'helpers/http-server.ts')], { env: { ...process.env, SUBONE_ROOT: directory }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let errors = ''; child.stderr?.on('data', chunk => { errors += chunk; });
  const message = await Promise.race([once(child, 'message'), once(child, 'exit').then(([code]) => { throw new Error(`Server exited ${code}: ${errors}`); })]);
  origin = `http://127.0.0.1:${message[0].port}`;
});
after(async () => {
  if (child) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; }
  await new Promise<void>(resolve => upstream.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
});
async function source(label: string, server: string, protocol = 'socks') {
  const path = `/${encodeURIComponent(label)}`;
  bodies.set(path, JSON.stringify({ outbounds: [{ type: protocol, tag: label, server, server_port: 1080, ...(protocol === 'shadowsocks' ? { method: 'aes-128-gcm', password: 'ordinary' } : {}) }] }));
  const result = await api('/sources', 'POST', { name: label, url: upstreamOrigin + path }); assert.equal(result.success, true, result.message); assert.equal(result.data.nodes.length, 1, JSON.stringify(result)); return result.data;
}
async function profile(target: string, content: string, ordinary: any) {
  const groupResult = await api('/groups', 'POST', { name: `Safe-${Math.random()}`, type: 'select', proxies: ['DIRECT'] }); assert.equal(groupResult.success, true, JSON.stringify(groupResult)); const group = groupResult.data;
  const templateResult = await api('/templates', 'POST', { name: `${target} routing`, type: target, content }); assert.equal(templateResult.success, true, JSON.stringify(templateResult)); const template = templateResult.data;
  const ruleResult = await api('/rules/unified', 'POST', { name: 'Ordinary local rule', kind: 'local', type: 'DOMAIN', payload: 'ordinary.example', outbound: 'DIRECT', enabled: true }); assert.equal(ruleResult.success, true, JSON.stringify(ruleResult)); const rule = ruleResult.data;
  const result = await api('/profiles', 'POST', { name: `${target} ordinary routing`, nodeFilter: { mode: 'manual', selectedNodeIds: [ordinary.nodes[0].id] }, selectedGroupIds: [group.id], selectedRuleIds: [rule.id], templates: { [target]: template.id } });
  assert.equal(result.success, true, result.message); return result.data;
}
const targets = ['singbox', 'mihomo', 'loon', 'quantumultx', 'egern', 'shadowrocket'];
function template(target: string, group: string, final = true): string {
  if (target === 'singbox') return JSON.stringify({ log: { disabled: true }, outbounds: [{ type: 'direct', tag: 'DIRECT' }, { type: 'direct', tag: '🎯 本地直连' }], route: final ? { final: group } : { rules: [{ domain: ['retained.example'], outbound: group }], final: 'DIRECT' } });
  if (target === 'mihomo') return yaml.dump({ mode: 'rule', proxies: [], 'proxy-groups': [], rules: [final ? `MATCH,${group}` : `DOMAIN,retained.example,${group}`, ...(!final ? ['MATCH,DIRECT'] : [])] });
  if (target === 'egern') return yaml.dump({ proxies: [], policy_groups: [], rules: final ? [{ default: { policy: group } }] : [{ domain: { match: 'retained.example', policy: group } }, { default: { policy: 'DIRECT' } }] });
  if (target === 'quantumultx') return `[general]\n[dns]\n[server_local]\n[policy]\n[filter_local]\n${final ? 'final' : 'host,retained.example'},${group}\n${!final ? 'final,direct\n' : ''}`;
  return `[General]\ndns-server = system\n[Proxy]\n[Proxy Group]\n[Rule]\n${final ? 'FINAL' : 'DOMAIN,retained.example'},${group}\n${!final ? 'FINAL,DIRECT\n' : ''}`;
}
function groupMembers(target: string, output: string, name: string): string[] {
  if (target === 'singbox') return JSON.parse(output).outbounds.find((group: any) => group.tag === name)?.outbounds;
  if (target === 'mihomo') return (yaml.load(output) as any)['proxy-groups'].find((group: any) => group.name === name)?.proxies;
  if (target === 'egern') return (yaml.load(output) as any).policy_groups.map((group: any) => Object.values(group)[0]).find((group: any) => group.name === name)?.policies;
  const line = output.split('\n').find(line => target === 'quantumultx' ? line.startsWith(`static=${name},`) : line.startsWith(`${name} = `));
  assert.ok(line, output);
  return line.split(',').slice(1).map(value => value.trim()).filter(value => !value.includes('='));
}
function withRule(target: string, content: string, outbound: string): string {
  if (target === 'singbox') { const doc = JSON.parse(content); doc.route.rules = [{ domain: ['explicit.example'], outbound }, ...(doc.route.rules || [])]; return JSON.stringify(doc); }
  if (target === 'mihomo' || target === 'egern') { const doc = yaml.load(content) as any; doc.rules.unshift(target === 'mihomo' ? `DOMAIN,explicit.example,${outbound}` : { domain: { match: 'explicit.example', policy: outbound } }); return yaml.dump(doc); }
  return target === 'quantumultx' ? content.replace('[filter_local]', `[filter_local]\nhost,explicit.example,${outbound}`) : content.replace('[Rule]', `[Rule]\nDOMAIN,explicit.example,${outbound}`);
}
async function checkNative(target: string, content: string) {
  const binary = target === 'singbox' ? process.env.SUBONE_SINGBOX_BINARY : target === 'mihomo' ? process.env.SUBONE_TEST_MIHOMO : undefined;
  if (!binary) return;
  const runtime = await mkdtemp(join(directory, `${target}-native-`)); const path = join(runtime, target === 'singbox' ? 'config.json' : 'config.yaml'); await writeFile(path, content);
  const checked = spawnSync(binary, target === 'singbox' ? ['check', '-c', path] : ['-t', '-d', runtime, '-f', path], { encoding: 'utf8', timeout: 5000 });
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
  const started = spawnSync(binary, target === 'singbox' ? ['run', '-c', path] : ['-d', runtime, '-f', path], { encoding: 'utf8', timeout: 1000 });
  assert.equal((started.error as NodeJS.ErrnoException)?.code, 'ETIMEDOUT', started.stdout + started.stderr);
  assert.doesNotMatch(started.stdout + started.stderr, /FATAL|Parse config error|default outbound not found|proxy .* not found/i);
}

test('Loon retained FINAL does not import a source excluded from ordinary candidates', async () => {
  const allowed = await source('Allowed FINAL', '192.0.2.1');
  const excluded = await source('Excluded FINAL', '192.0.2.2');
  const group = (await api('/groups', 'POST', { name: 'Excluded FINAL mount', type: 'select', sources: [excluded.id] })).data;
  const selected = await profile('loon', `[General]\ndns-server = system\n[Proxy]\n[Proxy Group]\n[Rule]\nFINAL,${group.name}\n`, allowed);
  const preview = await api('/generate/preview', 'POST', { profileId: selected.id, customType: 'loon', expandNodes: true });
  assert.equal(preview.status, 200, JSON.stringify(preview));
  assert.deepEqual(groupMembers('loon', preview.data, group.name), ['REJECT']);
  assert.equal(preview.generation.dependencyNodeCount, 0);
  const actual = await fetch(`${origin}/s/${selected.token}/loon?expand=true`); assert.equal(actual.status, 200); assert.equal(await actual.text(), preview.data);
});

test('retained ordinary rules and FINAL resolve unselected managed groups using allowed candidates in every complete format', async () => {
  const allowed = await source('Allowed native root', '192.0.2.3');
  const group = (await api('/groups', 'POST', { name: 'Allowed native mount', type: 'select', sources: [allowed.id] })).data;
  for (const target of targets) for (const final of [true, false]) {
    const selected = await profile(target, template(target, group.name, final), allowed);
    const preview = await api('/generate/preview', 'POST', { profileId: selected.id, customType: target, expandNodes: true });
    assert.equal(preview.status, 200, `${target} ${final}: ${JSON.stringify(preview)}`);
    assert.equal(preview.generation.dependencyNodeCount, 0);
    assert.doesNotMatch(preview.data, /(?:group|node|unresolved|ambiguous):/);
    assert.deepEqual(groupMembers(target, preview.data, group.name), [allowed.nodes[0].name], `${target} ${final}`);
    await checkNative(target, preview.data);
    const actual = await fetch(`${origin}/s/${selected.token}/${target}?expand=true`); assert.equal(actual.status, 200); assert.equal(await actual.text(), preview.data);
  }
});

test('ordinary rule and FINAL mounts cannot restore excluded candidates in any complete format', async () => {
  const allowed = await source('Allowed isolated root', '192.0.2.4');
  const excluded = await source('Excluded isolated root', '192.0.2.5');
  const group = (await api('/groups', 'POST', { name: 'Excluded ordinary mount', type: 'select', sources: [excluded.id] })).data;
  for (const target of targets) for (const final of [true, false]) {
    const selected = await profile(target, template(target, group.name, final), allowed);
    const preview = await api('/generate/preview', 'POST', { profileId: selected.id, customType: target, expandNodes: true });
    assert.equal(preview.status, 200, `${target} ${final}: ${JSON.stringify(preview)}`);
    assert.equal(preview.generation.dependencyNodeCount, 0, `${target} ${final}`);
    assert.deepEqual(groupMembers(target, preview.data, group.name), [target === 'quantumultx' ? 'reject' : 'REJECT']);
    const actual = await fetch(`${origin}/s/${selected.token}/${target}?expand=true`); assert.equal(actual.status, 200, `${target} ${final}`); assert.equal(await actual.text(), preview.data);
  }
});

test('explicit stable node pins complete dependencies while other ordinary mounts keep the original candidate pool', async () => {
  const allowed = await source('Allowed stable pin', '192.0.2.6');
  const excluded = await source('Excluded stable pin', '192.0.2.7');
  const pinned = (await api('/groups', 'POST', { name: 'Explicit stable pin', type: 'select', proxies: [`node:${excluded.nodes[0].id}`] })).data;
  const mounted = (await api('/groups', 'POST', { name: 'Immutable excluded mount', type: 'select', sources: [excluded.id] })).data;
  for (const target of targets) {
    const selected = await profile(target, template(target, pinned.name), allowed);
    const valid = await api('/generate/preview', 'POST', { profileId: selected.id, customType: target, expandNodes: true });
    assert.equal(valid.status, 200, `${target}: ${JSON.stringify(valid)}`);
    assert.equal(valid.generation.nodeCount, 1); assert.equal(valid.generation.dependencyNodeCount, 1);
    assert.deepEqual(groupMembers(target, valid.data, pinned.name), [excluded.nodes[0].name]);
    assert.doesNotMatch(valid.data, /(?:group|node|unresolved|ambiguous):/);
    const mixed = await profile(target, withRule(target, template(target, mounted.name), pinned.name), allowed);
    const result = await api('/generate/preview', 'POST', { profileId: mixed.id, customType: target, expandNodes: true });
    assert.equal(result.status, 200, `${target}: ${JSON.stringify(result)}`);
    assert.equal(result.generation.dependencyNodeCount, 1, target);
    assert.deepEqual(groupMembers(target, result.data, mounted.name), [target === 'quantumultx' ? 'reject' : 'REJECT']);
    assert.deepEqual(groupMembers(target, result.data, pinned.name), [excluded.nodes[0].name]);
    const actual = await fetch(`${origin}/s/${mixed.token}/${target}?expand=true`); assert.equal(actual.status, 200, target); assert.equal(await actual.text(), result.data);
  }
});

test('ordinary native group roots remain valid when complete output uses protected source providers', async () => {
  const allowed = await source('Allowed provider root', '192.0.2.8', 'shadowsocks');
  const group = (await api('/groups', 'POST', { name: 'Allowed provider mount', type: 'select', sources: [allowed.id] })).data;
  for (const target of targets) {
    const selected = await profile(target, template(target, group.name), allowed);
    const preview = await api('/generate/preview', 'POST', { profileId: selected.id, customType: target, expandNodes: false });
    assert.equal(preview.status, 200, `${target}: ${JSON.stringify(preview)}`);
    assert.equal(preview.generation.dependencyNodeCount, 0);
    assert.doesNotMatch(preview.data, /(?:group|node|unresolved|ambiguous):/);
    await checkNative(target, preview.data);
    const actual = await fetch(`${origin}/s/${selected.token}/${target}?expand=false`); assert.equal(actual.status, 200, target); assert.equal(await actual.text(), preview.data);
    const provider = await fetch(`${origin}/s/${selected.token}/source/${allowed.id}/${target}`); assert.equal(provider.status, 200, target);
    assert.ok((await provider.text()).length, target);
  }
});

test('six downloads and previews merge explicit members with matches on final names and reject ordinary empty groups', async () => {
  const entries = ['大阪 inbound', 'Osaka backup', '東京 fixed'].map((name, index) => ({
    name, type: 'ss', server: '192.0.2.' + (181 + index), port: 443, cipher: 'aes-128-gcm', password: 'fixture',
  }));
  const saved = (await api('/sources', 'POST', { name: 'Final names', acquisition: 'manual', content: yaml.dump({ proxies: entries }), nameTemplate: '{region_emoji} {region}' })).data;
  const add = async (name: string, filter: string, proxies: string[] = []) => (await api('/groups', 'POST', { name, type: 'select', sources: [saved.id], filter, proxies })).data;
  const anchored = await add('Anchored empty', '^大阪');
  const explicit = await add('Pinned only', '^大阪', ['node:' + saved.nodes[2].id]);
  const suffix = await add('Merged suffix', '大阪 \\(2\\)$', ['node:' + saved.nodes[2].id]);
  for (const target of targets) {
    const tpl = (await api('/templates', 'POST', { name: target + ' final members', type: target, content: template(target, explicit.name) })).data;
    const selected = (await api('/profiles', 'POST', { name: 'Final membership', nodeFilter: { mode: 'all', sourceIds: [saved.id] }, selectedGroupIds: [anchored.id, explicit.id, suffix.id], selectedRuleIds: ['no-rules'], templates: { [target]: tpl.id } })).data;
    const result = await api('/generate/preview', 'POST', { profileId: selected.id, customType: target });
    assert.equal(result.status, 200, target + JSON.stringify(result));
    assert.deepEqual(groupMembers(target, result.data, anchored.name), [target === 'quantumultx' ? 'reject' : 'REJECT'], target);
    assert.deepEqual(groupMembers(target, result.data, explicit.name), ['🇯🇵 东京'], target);
    assert.deepEqual(groupMembers(target, result.data, suffix.name), ['🇯🇵 东京', '🇯🇵 大阪 (2)'], target);
    const download = await fetch(origin + '/s/' + selected.token + '/' + target);
    assert.equal(download.status, 200, target);
    assert.equal(await download.text(), result.data, target);
  }
});

test('an ordinary relay with no hops emits only the native reject member in every target', async () => {
  const allowed = await source('Empty relay candidate', '192.0.2.185');
  const relay = (await api('/groups', 'POST', { name: 'Empty relay', type: 'relay', proxies: [] })).data;
  for (const target of targets) {
    const selected = await profile(target, template(target, relay.name), allowed);
    const result = await api('/generate/preview', 'POST', { profileId: selected.id, customType: target });
    assert.equal(result.status, 200, target + JSON.stringify(result));
    assert.deepEqual(groupMembers(target, result.data, relay.name), [target === 'quantumultx' ? 'reject' : 'REJECT']);
    assert.equal(await fetch(origin + '/s/' + selected.token + '/' + target).then(response => response.text()), result.data);
  }
});

test('a stable source mount matches only that upstream when two sources have the same display name', async () => {
  const first = await source('Mounted Osaka', '192.0.2.186');
  const other = await source('Other Osaka', '192.0.2.187');
  for (const entry of [first, other]) await api('/sources/' + entry.id, 'PUT', { name: 'Shared airport', nameTemplate: '{region} {region_index}' });
  const group = (await api('/groups', 'POST', { name: 'One source only', type: 'select', sources: [first.id], filter: '大阪' })).data;
  const selected = await profile('singbox', template('singbox', group.name), first);
  await api('/profiles/' + selected.id, 'PUT', { nodeFilter: { mode: 'manual', selectedNodeIds: [first.nodes[0].id, other.nodes[0].id] } });
  const result = await api('/generate/preview', 'POST', { profileId: selected.id, customType: 'singbox' });
  assert.equal(result.status, 200, result.message);
  assert.deepEqual(groupMembers('singbox', result.data, group.name), ['大阪 01']);
});

test('a selected group carries explicit node identities even without a native routing rule pointing to it', async () => {
  const ordinary = await source('Ordinary selected group', '192.0.2.188');
  const exit = await source('Pinned selected group', '192.0.2.189');
  const pinned = (await api('/groups', 'POST', { name: 'Retained pin', type: 'select', proxies: ['node:' + exit.nodes[0].id], filter: '^never$' })).data;
  for (const target of targets) {
    const selected = await profile(target, template(target, 'DIRECT'), ordinary);
    await api('/profiles/' + selected.id, 'PUT', { selectedGroupIds: [pinned.id] });
    const result = await api('/generate/preview', 'POST', { profileId: selected.id, customType: target });
    assert.equal(result.status, 200, target + JSON.stringify(result));
    assert.equal(result.generation.dependencyNodeCount, 1, target);
    assert.deepEqual(groupMembers(target, result.data, pinned.name), ['Pinned selected group'], target);
  }
});

test('Quantumult X keeps latency policy settings when writing final members', async () => {
  const allowed = await source('Latency choice', '192.0.2.190');
  const group = (await api('/groups', 'POST', { name: 'Filtered latency', type: 'urltest', filter: 'Latency', tolerance: 77 })).data;
  const selected = await profile('quantumultx', template('quantumultx', group.name), allowed);
  const result = await api('/generate/preview', 'POST', { profileId: selected.id, customType: 'quantumultx' });
  assert.equal(result.status, 200, result.message);
  assert.match(result.data, /^url-latency-benchmark=Filtered latency, Latency choice, check-interval=300, tolerance=77(?:,|$)/m);
});
