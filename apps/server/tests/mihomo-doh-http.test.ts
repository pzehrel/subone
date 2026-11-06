import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import yaml from 'js-yaml';

let directory: string, child: ChildProcess, origin: string, upstreamOrigin: string;
const bodies = new Map<string, string>();
const upstream = createServer((request, response) => response.end(bodies.get(request.url || '/') || 'proxies: []'));
async function startApp() {
  child = spawn(process.execPath, ['--import', 'tsx', join(__dirname, 'helpers/http-server.ts')], { env: { ...process.env, SUBONE_ROOT: directory }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let errors = ''; child.stderr?.on('data', chunk => { errors += chunk; });
  const message = await Promise.race([once(child, 'message'), once(child, 'exit').then(([code]) => { throw new Error(`Server exited ${code}: ${errors}`); })]);
  origin = `http://127.0.0.1:${message[0].port}`;
}
async function stopApp() { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; }
async function api(path: string, method = 'GET', value?: unknown): Promise<any> {
  const response = await fetch(`${origin}/api${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: value === undefined ? undefined : JSON.stringify(value) });
  return { status: response.status, ...await response.json() as any };
}
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'subone-mihomo-http-'));
  await writeFile(join(directory, 'config.json'), JSON.stringify({ port: 3456, adminPassword: '' }));
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening'); const address = upstream.address(); assert.ok(address && typeof address !== 'string');
  upstreamOrigin = `http://127.0.0.1:${address.port}`; await startApp();
});
after(async () => { await stopApp(); await new Promise<void>(resolve => upstream.close(() => resolve())); await rm(directory, { recursive: true, force: true }); });
const template: any = {
  mode: 'rule', 'log-level': 'silent', ipv6: false,
  dns: { enable: true, listen: '127.0.0.1:0', 'default-nameserver': ['127.0.0.1:54535'], 'proxy-server-nameserver': ['127.0.0.1:54535'], nameserver: ['127.0.0.1:54535'], fallback: ['tls://192.0.2.54'], 'fallback-filter': { geoip: false }, 'cache-algorithm': 'arc', 'nameserver-policy': { 'kept.example': 'tls://192.0.2.54' }, 'proxy-server-nameserver-policy': { 'kept-node.example': ['127.0.0.1:54535'] } },
  proxies: [{ name: 'Template exit', type: 'socks5', server: '127.0.0.1', port: 34567 }],
  'proxy-groups': [{ name: 'Template choice', type: 'select', proxies: ['Template exit', 'DIRECT'] }],
  rules: ['DOMAIN,kept.example,Template choice', 'MATCH,DIRECT'], 'profile': { 'store-selected': false },
};
async function add(path: string, server: string, services: string[], extra: any = {}) {
  bodies.set(path, yaml.dump({ proxies: [{ name: 'Shared', type: 'socks5', server, port: 1080 }], dns: { nameserver: services }, ...extra }));
  const result = await api('/sources', 'POST', { name: path.slice(1), url: upstreamOrigin + path }); assert.equal(result.success, true, result.message); return result.data;
}
async function profileFor(sources: any[], content = template, filter?: any) {
  const group = (await api('/groups', 'POST', { name: `Candidates-${Math.random()}`, type: 'select', sources: sources.map(source => source.id) })).data;
  const tpl = (await api('/templates', 'POST', { name: 'Mihomo custom', type: 'mihomo', content: yaml.dump(content) })).data;
  const profile = (await api('/profiles', 'POST', { name: 'Mihomo profile', nodeFilter: filter || { mode: 'all', sourceIds: sources.map(source => source.id) }, selectedGroupIds: [group.id], selectedRuleIds: [], templates: { mihomo: tpl.id } })).data;
  return { profile, group, tpl };
}
const preview = (profile: any, expandNodes = true) => api('/generate/preview', 'POST', { profileId: profile.id, customType: 'mihomo', expandNodes });

test('Mihomo applies ordered source DoH by server domain and preserves native template definitions across reload', async () => {
  const a = await add('/domains-a', 'a.node.example', ['https://a.dns.example/dns-query', 'https://b.dns.example/dns-query#DIRECT']);
  const b = await add('/domains-b', 'b.node.example', ['https://other.dns.example/dns-query']);
  const { profile } = await profileFor([a, b]);
  const result = await preview(profile); assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.generation.target.version, '1.19.33');
  assert.deepEqual(result.generation.bindings.map((binding: any) => binding.status), ['applied', 'applied']);
  const doc: any = yaml.load(result.data);
  assert.deepEqual(doc.dns['proxy-server-nameserver-policy']['a.node.example'], ['https://a.dns.example/dns-query#DIRECT', 'https://b.dns.example/dns-query#DIRECT']);
  assert.deepEqual(doc.dns['proxy-server-nameserver-policy']['b.node.example'], ['https://other.dns.example/dns-query#DIRECT']);
  for (const key of ['nameserver', 'fallback', 'cache-algorithm', 'nameserver-policy', 'default-nameserver', 'proxy-server-nameserver']) assert.deepEqual(doc.dns[key], template.dns[key]);
  assert.deepEqual(doc.proxies.find((entry: any) => entry.name === 'Template exit'), template.proxies[0]);
  assert.deepEqual(doc['proxy-groups'].find((entry: any) => entry.name === 'Template choice'), template['proxy-groups'][0]);
  assert.ok(doc.rules.includes('DOMAIN,kept.example,Template choice'));
  assert.equal(await fetch(`${origin}/s/${profile.token}/mihomo?expand=true`).then(response => response.text()), result.data);
  await stopApp(); await startApp();
  assert.deepEqual(await preview(profile), result);
});

test('same server domain with incompatible sources keeps template policy and reports every unapplied binding', async () => {
  const a = await add('/conflict-a', 'shared.node.example', ['https://a.conflict.example/dns-query']);
  const b = await add('/conflict-b', 'shared.node.example', ['https://b.conflict.example/dns-query']);
  const content = structuredClone(template); content.dns['proxy-server-nameserver-policy']['shared.node.example'] = ['tls://192.0.2.55'];
  const { profile } = await profileFor([a, b], content);
  const result = await preview(profile); assert.equal(result.success, true, JSON.stringify(result));
  assert.deepEqual((yaml.load(result.data) as any).dns, content.dns);
  assert.equal(result.generation.bindings.length, 2);
  for (const binding of result.generation.bindings) {
    assert.equal(binding.status, 'unapplied'); assert.equal(binding.method, 'template-dns'); assert.deepEqual(binding.appliedServiceIds, []);
    assert.ok(binding.diagnostics.some((entry: any) => entry.code === 'source-doh-domain-conflict' && /shared.node.example/.test(entry.message)));
  }
  assert.equal(await fetch(`${origin}/s/${profile.token}/mihomo?expand=true`).then(response => response.text()), result.data);
  assert.equal((await api('/sources')).data.find((entry: any) => entry.id === a.id).doh.services[0].url, 'https://a.conflict.example/dns-query');
});

test('custom templates require explicit native shared resolvers and independent IP bootstrap without invented fallback', async () => {
  const source = await add('/missing-bootstrap', 'node.missing-bootstrap.example', ['https://dns.missing-bootstrap.example/dns-query']);
  for (const missing of ['proxy-server-nameserver', 'default-nameserver']) {
    const content = structuredClone(template); delete content.dns[missing];
    const { profile, tpl } = await profileFor([source], content);
    const result = await preview(profile); assert.equal(result.status, 422, JSON.stringify(result));
    assert.ok(result.generation.diagnostics.some((entry: any) => entry.code === 'source-doh-bootstrap-missing' && entry.message.includes(missing)));
    const actual = await fetch(`${origin}/s/${profile.token}/mihomo?expand=true`); assert.equal(actual.status, 422);
    assert.deepEqual((await actual.json() as any).generation, result.generation);
    assert.equal((await api('/templates')).data.find((entry: any) => entry.id === tpl.id).content, yaml.dump(content));
  }
  const content = structuredClone(template); content.dns['default-nameserver'] = ['https://bootstrap.domain.example/dns-query'];
  const { profile } = await profileFor([source], content);
  assert.equal((await preview(profile)).status, 422);
});

test('explicit native DoH exits and private groups use stable current names with provider parity', async () => {
  const source = await add('/private-egress', 'node.private-egress.example', ['https://dns.private-egress.example/dns-query#DNS%20choice&h3=false'], {
    proxies: [{ name: 'Shared', type: 'socks5', server: 'node.private-egress.example', port: 1080 }, { name: 'Exit', type: 'socks5', server: '192.0.2.20', port: 1080 }],
    'proxy-groups': [{ name: 'DNS choice', type: 'select', proxies: ['Exit', 'DIRECT'] }],
  });
  const { profile } = await profileFor([source]);
  const exit = source.nodes.find((node: any) => node.server === '192.0.2.20');
  await api(`/nodes/${exit.id}`, 'PUT', { name: 'Local stable exit' });
  await stopApp(); await startApp();
  const result = await preview(profile); assert.equal(result.success, true, JSON.stringify(result));
  const doc: any = yaml.load(result.data);
  const entry = doc.dns['proxy-server-nameserver-policy']['node.private-egress.example'][0];
  assert.match(entry, /h3=false/); assert.doesNotMatch(entry, /#DIRECT$/);
  const route = decodeURIComponent(entry.split('#')[1]).split('&').filter((entry: string) => !entry.includes('=')).at(-1);
  const group = doc['proxy-groups'].find((entry: any) => entry.name === route);
  assert.deepEqual(group.proxies, ['Local stable exit', 'DIRECT']);
  const provider = await preview(profile, false); assert.equal(provider.success, true, JSON.stringify(provider));
  const providerDoc: any = yaml.load(provider.data);
  assert.ok(providerDoc.proxies.some((entry: any) => entry.name === 'Local stable exit'));
  const providerResponse = await fetch(`${origin}/s/${profile.token}/source/${source.id}?target=mihomo`).then(response => response.text());
  assert.deepEqual((yaml.load(providerResponse) as any).proxies.map((entry: any) => entry.name).sort(), doc.proxies.filter((entry: any) => entry.name !== 'Template exit').map((entry: any) => entry.name).sort());
});

test('final native dependencies include every selectable member and reject direct or nested DNS cycles', async () => {
  for (const nested of [false, true]) {
    const source = await add(`/cycle-${nested}`, 'node.cycle.example', [`https://192.0.2.53/dns-query#${nested ? 'DNS%20choice' : 'Shared'}`], nested ? { 'proxy-groups': [{ name: 'DNS choice', type: 'select', proxies: ['DIRECT', 'Inner'] }, { name: 'Inner', type: 'select', proxies: ['Shared'] }] } : {});
    const { profile } = await profileFor([source]);
    const result = await preview(profile); assert.equal(result.status, 422, JSON.stringify(result));
    const diagnostic = result.generation.diagnostics.find((entry: any) => entry.code === 'source-doh-cycle');
    assert.ok(diagnostic, JSON.stringify(result)); assert.ok(diagnostic.path.length >= 3);
    assert.match(diagnostic.message, /Shared.*192.0.2.53.*Shared/);
    const actual = await fetch(`${origin}/s/${profile.token}/mihomo?expand=true`); assert.equal(actual.status, 422); assert.deepEqual((await actual.json() as any).generation, result.generation);
  }
});

test('fragment parsing follows native decoding, last bare token and exact case without interface fallback', async () => {
  const source = await add('/fragment-native', 'node.fragment.example', ['https://dns.fragment.example/dns-query#Unknown%26DIRECT']);
  const { profile } = await profileFor([source]);
  const result = await preview(profile); assert.equal(result.success, true, JSON.stringify(result));
  assert.equal((yaml.load(result.data) as any).dns['proxy-server-nameserver-policy']['node.fragment.example'][0], 'https://dns.fragment.example/dns-query#DIRECT');
  const broken = await add('/fragment-typo', 'node.fragment-typo.example', ['https://dns.fragment.example/dns-query#direct']);
  const brokenProfile = (await profileFor([broken])).profile;
  const missing = await preview(brokenProfile); assert.equal(missing.status, 422); assert.ok(missing.generation.diagnostics.some((entry: any) => entry.code === 'source-doh-dependency-missing'));
  const unsafe = await add('/fragment-rename', 'node.fragment-rename.example', ['https://dns.fragment.example/dns-query#Exit'], { proxies: [{ name: 'Shared', type: 'socks5', server: 'node.fragment-rename.example', port: 1080 }, { name: 'Exit', type: 'socks5', server: '192.0.2.21', port: 1080 }] });
  const unsafeProfile = (await profileFor([unsafe])).profile;
  await api(`/nodes/${unsafe.nodes.find((node: any) => node.name === 'Exit').id}`, 'PUT', { name: 'Exit&unsafe' });
  const degraded = await preview(unsafeProfile); assert.equal(degraded.success, true, JSON.stringify(degraded)); assert.equal(degraded.generation.bindings[0].status, 'unapplied');
  assert.deepEqual((yaml.load(degraded.data) as any).dns, template.dns);
});

test('unrepresentable source bootstrap and routing choices retain template DNS with explicit capacity diagnostics', async () => {
  const source = await add('/bootstrap-capacity', 'node.bootstrap-capacity.example', ['https://dns.bootstrap-capacity.example/dns-query'], { dns: { 'default-nameserver': ['192.0.2.99'], nameserver: ['https://dns.bootstrap-capacity.example/dns-query'] } });
  const { profile } = await profileFor([source]);
  const result = await preview(profile); assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.generation.bindings[0].status, 'unapplied');
  assert.ok(result.generation.diagnostics.some((entry: any) => entry.code === 'source-doh-bootstrap-unapplied'));
  assert.deepEqual((yaml.load(result.data) as any).dns, template.dns);
  const routing = await add('/routing-capacity', 'node.routing-capacity.example', [], { dns: { 'respect-rules': true, nameserver: ['https://dns.routing.example/dns-query'] } });
  const routingProfile = (await profileFor([routing])).profile;
  const routingResult = await preview(routingProfile); assert.equal(routingResult.success, true, JSON.stringify(routingResult));
  assert.equal(routingResult.generation.bindings[0].status, 'unapplied');
  assert.ok(routingResult.generation.diagnostics.some((entry: any) => entry.code === 'source-doh-egress-unapplied'));
  assert.deepEqual((yaml.load(routingResult.data) as any).dns, template.dns);
});

test('source DoH removal and IP-only unused bindings preserve template DNS and disabled nodes stay outside providers', async () => {
  const source = await add('/removal', 'node.removal.example', ['https://dns.removal.example/dns-query']);
  const { profile } = await profileFor([source]);
  assert.equal((await preview(profile)).generation.bindings[0].status, 'applied');
  bodies.set('/removal', yaml.dump({ proxies: [{ name: 'Renamed upstream', type: 'socks5', server: 'node.removal.example', port: 1080 }], dns: { nameserver: ['tls://192.0.2.53'] } }));
  assert.equal((await api(`/sources/${source.id}/refresh`, 'POST')).success, true);
  const removed = await preview(profile); assert.equal(removed.success, true, JSON.stringify(removed)); assert.deepEqual((yaml.load(removed.data) as any).dns, template.dns); assert.equal(removed.generation.bindings[0].method, 'template-dns');
  await api(`/nodes/${source.nodes[0].id}`, 'PUT', { enabled: false });
  const disabled = await preview(profile, false); assert.equal(disabled.success, true, JSON.stringify(disabled));
  const providerDoc: any = yaml.load(await fetch(`${origin}/s/${profile.token}/source/${source.id}?target=mihomo`).then(response => response.text())); assert.deepEqual(providerDoc.proxies, []);
  const ip = await add('/unused-ip', '192.0.2.10', ['https://dns.unused.example/dns-query#Missing-unused']);
  const ipProfile = (await profileFor([ip])).profile;
  const ipResult = await preview(ipProfile); assert.equal(ipResult.success, true, JSON.stringify(ipResult)); assert.equal(ipResult.generation.bindings[0].method, 'ip-node-no-dns'); assert.deepEqual((yaml.load(ipResult.data) as any).dns, template.dns);
});

test('actual generated Mihomo1.19.33 configuration passes native check and bounded isolated startup', { skip: !process.env.SUBONE_TEST_MIHOMO }, async () => {
  const source = await add('/native-loaded', 'node.native.example', ['https://dns.native.example/dns-query#DNS%20choice', 'https://192.0.2.53/dns-query#DIRECT'], { proxies: [{ name: 'Shared', type: 'socks5', server: 'node.native.example', port: 1080 }, { name: 'Exit', type: 'socks5', server: '127.0.0.1', port: 34567 }], 'proxy-groups': [{ name: 'DNS choice', type: 'select', proxies: ['Exit', 'DIRECT'] }] });
  const content = structuredClone(template); content['log-level'] = 'info';
  const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const address = reservation.address(); assert.ok(address && typeof address !== 'string'); content.dns.listen = `127.0.0.1:${address.port}`;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const { profile } = await profileFor([source], content);
  const rule = (await api('/rules/unified', 'POST', { name: 'Native direct', kind: 'local', type: 'DOMAIN', payload: 'native.kept.example', outbound: 'DIRECT', enabled: true })).data;
  await api(`/profiles/${profile.id}`, 'PUT', { selectedRuleIds: [rule.id] });
  const result = await preview(profile); assert.equal(result.success, true, JSON.stringify(result));
  const runtime = await mkdtemp(join(tmpdir(), 'subone-mihomo-native-'));
  const path = join(runtime, 'config.yaml'); await writeFile(path, result.data);
  const checked = spawnSync(process.env.SUBONE_TEST_MIHOMO!, ['-t', '-d', runtime, '-f', path], { encoding: 'utf8', timeout: 5000 });
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
  const started = spawnSync(process.env.SUBONE_TEST_MIHOMO!, ['-d', runtime, '-f', path], { encoding: 'utf8', timeout: 1800, killSignal: 'SIGTERM' });
  assert.equal((started.error as NodeJS.ErrnoException)?.code, 'ETIMEDOUT', started.stdout + started.stderr);
  assert.match(started.stdout + started.stderr, /DNS server listening at|DNS server\(TCP\) listening at/);
  assert.doesNotMatch(started.stdout + started.stderr, /level=fatal|Parse config error/i);
  if (process.env.SUBONE_MIHOMO_ARTIFACT) await writeFile(process.env.SUBONE_MIHOMO_ARTIFACT, result.data);
  await rm(runtime, { recursive: true, force: true });
});

test('omitted necessary exits become static dependencies while ordinary groups, GLOBAL and providers retain only the selection', async () => {
  const source = await add('/omitted-egress', 'ordinary.omitted.example', ['https://192.0.2.53/dns-query#Exit'], { proxies: [{ name: 'Ordinary selected', type: 'socks5', server: 'ordinary.omitted.example', port: 1080 }, { name: 'Exit', type: 'socks5', server: '192.0.2.30', port: 1080 }] });
  const ordinary = source.nodes.find((node: any) => node.server === 'ordinary.omitted.example'); const exit = source.nodes.find((node: any) => node.server === '192.0.2.30');
  const { profile, group } = await profileFor([source], template, { mode: 'manual', selectedNodeIds: [ordinary.id] });
  const result = await preview(profile); assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.generation.nodeCount, 1); assert.equal(result.generation.dependencyNodeCount, 1);
  const doc: any = yaml.load(result.data);
  assert.ok(doc.proxies.some((entry: any) => entry.server === '192.0.2.30'));
  assert.deepEqual(doc['proxy-groups'].find((entry: any) => entry.name === group.name).proxies, ['Ordinary selected']);
  assert.equal(doc['proxy-groups'].find((entry: any) => entry.name === 'GLOBAL').proxies.includes('Exit'), false);
  const response = await fetch(`${origin}/s/${profile.token}/source/${source.id}?target=mihomo`); assert.equal(response.status, 200);
  assert.deepEqual((yaml.load(await response.text()) as any).proxies.map((entry: any) => entry.name), ['Ordinary selected']);
  const remote = await preview(profile, false); assert.equal(remote.success, true, JSON.stringify(remote));
  const remoteDoc: any = yaml.load(remote.data); assert.ok(remoteDoc.proxies.some((entry: any) => entry.name === 'Exit'));
  assert.match(remoteDoc['proxy-providers'][source.name].url, new RegExp(`/s/${profile.token}/source/${source.id}\\?target=mihomo$`));
  await api(`/nodes/${exit.id}`, 'PUT', { enabled: false });
  const disabled = await preview(profile); assert.equal(disabled.status, 422);
  assert.ok(disabled.generation.diagnostics.some((entry: any) => entry.dependencyState === 'node-disabled'));
  await api(`/nodes/${exit.id}`, 'PUT', { enabled: true }); await stopApp(); await startApp();
  assert.equal((await preview(profile)).generation.dependencyNodeCount, 1);
});

test('template bootstrap reaches unselected managed strategies with stable source-local dependencies and checks all members', async () => {
  const source = await add('/managed-bootstrap-a', 'node.managed-bootstrap.example', ['https://dns.managed-bootstrap.example/dns-query']);
  const exitSource = await add('/managed-bootstrap-b', '192.0.2.41', []);
  const exit = exitSource.nodes[0];
  const managed = (await api('/groups', 'POST', { name: 'Managed bootstrap', type: 'select', sources: [exitSource.id] })).data;
  const content = structuredClone(template); content.dns['default-nameserver'] = ['https://127.0.0.1/dns-query#Managed%20bootstrap'];
  const { profile } = await profileFor([source], content);
  const result = await preview(profile); assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.generation.nodeCount, 1); assert.equal(result.generation.dependencyNodeCount, 1);
  assert.equal(result.generation.dependencyNodes[0].id, exit.id);
  assert.equal((await preview(profile, false)).success, true);
  const doc: any = yaml.load(result.data);
  const actualExit = doc.proxies.find((entry: any) => entry.server === '192.0.2.41');
  assert.deepEqual(doc['proxy-groups'].find((entry: any) => entry.name === 'Managed bootstrap').proxies, [actualExit.name]);
  const global = doc['proxy-groups'].find((entry: any) => entry.name === 'GLOBAL'); assert.equal(global.proxies.includes('Managed bootstrap'), false); assert.equal(global.proxies.includes(actualExit.name), false);
  await api(`/groups/${managed.id}`, 'PUT', { name: 'Renamed bootstrap' }); await api(`/nodes/${exit.id}`, 'PUT', { name: 'Renamed managed exit' });
  await stopApp(); await startApp();
  const renamed = await preview(profile); assert.equal(renamed.success, true, JSON.stringify(renamed));
  assert.match((yaml.load(renamed.data) as any).dns['default-nameserver'][0], /#Renamed%20bootstrap$/);
  await api(`/sources/${exitSource.id}`, 'PUT', { enabled: false });
  const disabled = await preview(profile); assert.equal(disabled.status, 422, JSON.stringify(disabled));
  assert.ok(disabled.generation.diagnostics.some((entry: any) => entry.code === 'source-doh-dependency-missing'));
});

test('a capacity-limited binding does not add any unused DNS exit from another service in its array', async () => {
  const source = await add('/unused-array', 'node.unused-array.example', ['https://192.0.2.53/dns-query#Exit', 'https://192.0.2.54/dns-query#Dynamic'], {
    proxies: [{ name: 'Ordinary', type: 'socks5', server: 'node.unused-array.example', port: 1080 }, { name: 'Exit', type: 'socks5', server: '192.0.2.55', port: 1080 }],
    'proxy-groups': [{ name: 'Dynamic', type: 'select', use: ['unavailable-provider'] }],
  });
  const ordinary = source.nodes.find((node: any) => node.server === 'node.unused-array.example');
  const { profile } = await profileFor([source], template, { mode: 'manual', selectedNodeIds: [ordinary.id] });
  const result = await preview(profile); assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.generation.bindings[0].status, 'unapplied'); assert.equal(result.generation.dependencyNodeCount, 0);
  assert.deepEqual((yaml.load(result.data) as any).dns, template.dns);
  assert.equal((yaml.load(result.data) as any).proxies.some((entry: any) => entry.server === '192.0.2.55'), false);
});

test('prospective bootstrap dependencies with conflicting server-domain bindings degrade before adding unused nodes', async () => {
  const source = await add('/prospective-a', 'shared.prospective.example', ['https://dns.prospective.example/dns-query']);
  const other = await add('/prospective-b', 'shared.prospective.example', ['https://other.prospective.example/dns-query']);
  const managed = (await api('/groups', 'POST', { name: 'Prospective bootstrap', type: 'select', sources: [other.id] })).data;
  const content = structuredClone(template); content.dns['default-nameserver'] = [`https://127.0.0.1/dns-query#${encodeURIComponent(managed.name)}`];
  const { profile } = await profileFor([source], content);
  const result = await preview(profile); assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.generation.bindings[0].status, 'unapplied'); assert.equal(result.generation.dependencyNodeCount, 0);
  assert.ok(result.generation.diagnostics.some((entry: any) => entry.code === 'source-doh-domain-conflict'));
  assert.deepEqual((yaml.load(result.data) as any).dns['proxy-server-nameserver-policy'], content.dns['proxy-server-nameserver-policy']);
  assert.equal((yaml.load(result.data) as any)['proxy-groups'].some((entry: any) => entry.name === managed.name), false);
});
