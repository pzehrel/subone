import assert from 'node:assert/strict';
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
async function startApp() {
  child = spawn(process.execPath, ['--import', 'tsx', join(__dirname, 'helpers/http-server.ts')], {
    env: { ...process.env, SUBONE_ROOT: directory }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let errors = '';
  child.stderr?.on('data', chunk => { errors += chunk; });
  const message = await Promise.race([once(child, 'message'), once(child, 'exit').then(([code]) => { throw new Error(`Server exited ${code}: ${errors}`); })]);
  origin = `http://127.0.0.1:${message[0].port}`;
}
async function stopApp() { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; }
async function api(path: string, method = 'GET', value?: unknown) {
  const response = await fetch(`${origin}/api${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: value === undefined ? undefined : JSON.stringify(value) });
  return { status: response.status, ...(await response.json() as any) };
}
async function source(id: string) { return (await api('/sources')).data.find((entry: any) => entry.id === id); }

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'subone-generation-http-'));
  await writeFile(join(directory, 'config.json'), JSON.stringify({ port: 3456, adminPassword: '' }));
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const address = upstream.address(); assert.ok(address && typeof address !== 'string');
  upstreamOrigin = `http://127.0.0.1:${address.port}`; await startApp();
});
after(async () => { await stopApp(); await new Promise<void>(resolve => upstream.close(() => resolve())); await rm(directory, { recursive: true, force: true }); });

const template = {
  log: { disabled: true },
  dns: { servers: [
    { type: 'udp', tag: 'bootstrap', server: '127.0.0.1', server_port: 54535 },
    { type: 'tls', tag: 'template-dot', server: '192.0.2.54', server_port: 853 },
  ], rules: [{ domain_suffix: ['template.example'], server: 'template-dot' }], final: 'bootstrap', cache_capacity: 512 },
  route: { default_domain_resolver: { server: 'bootstrap' }, rules: [{ domain: ['kept.example'], outbound: 'template-direct' }] },
  outbounds: [{ type: 'direct', tag: 'template-direct' }],
};
async function addSource(path: string, dns: unknown[], server: string) {
  bodies.set(path, JSON.stringify({ outbounds: [{ type: 'socks', tag: 'Shared', server, server_port: 1080, version: '5' }], dns: { servers: dns } }));
  const response = await api('/sources', 'POST', { name: path.slice(1), url: upstreamOrigin + path });
  assert.equal(response.success, true, response.message);
  return response.data;
}
async function profileFor(sources: any[], content: Record<string, unknown> = template) {
  const group = (await api('/groups', 'POST', { name: `Candidates-${Math.random()}`, type: 'select', sources: sources.map(source => source.id) })).data;
  const rule = (await api('/rules/unified', 'POST', { name: 'Isolated rule', kind: 'local', type: 'DOMAIN', payload: 'isolated.example', outbound: 'template-direct', enabled: true })).data;
  const tpl = (await api('/templates', 'POST', { name: 'Generation template', type: 'singbox', content: JSON.stringify(content) })).data;
  return (await api('/profiles', 'POST', { name: 'Generation profile', nodeFilter: { mode: 'all', sourceIds: sources.map(source => source.id) }, selectedGroupIds: [group.id], selectedRuleIds: [rule.id], templates: { singbox: tpl.id } })).data;
}
test('explicit source DoH egress remains distinct from node server DNS in final native output', async () => {
  bodies.set('/egress', JSON.stringify({ outbounds: [
    { type: 'socks', tag: 'Ordinary', server: 'node.egress.example', server_port: 1080 },
    { type: 'socks', tag: 'Exit', server: '192.0.2.20', server_port: 1080 },
  ], dns: { servers: [{ type: 'https', server: 'dns.egress.example', detour: 'Exit', tls: { server_name: 'tls.egress.example' } }] } }));
  const added = await api('/sources', 'POST', { name: 'Egress source', url: upstreamOrigin + '/egress' });
  assert.equal(added.success, true, added.message);
  const profile = await profileFor([added.data]);
  const preview = await api('/generate/preview', 'POST', { profileId: profile.id, customType: 'singbox' });
  assert.equal(preview.success, true, preview.message);
  assert.equal(preview.generation.bindings[0].status, 'applied');
  const doc = JSON.parse(preview.data);
  const node = doc.outbounds.find((entry: any) => entry.server === 'node.egress.example');
  const exit = doc.outbounds.find((entry: any) => entry.server === '192.0.2.20');
  const doh = doc.dns.servers.find((entry: any) => entry.tag === node.domain_resolver.server);
  assert.equal(doh.detour, exit.tag);
  assert.equal(doh.domain_resolver.server, 'bootstrap');
  assert.deepEqual(doh.tls, { server_name: 'tls.egress.example' });
  assert.equal(await fetch(`${origin}/s/${profile.token}/singbox`).then(response => response.text()), preview.data);
  const exitId = added.data.nodes.find((node: any) => node.server === '192.0.2.20').id;
  await api(`/nodes/${exitId}`, 'PUT', { name: 'Renamed stable exit' });
  await api(`/sources/${added.data.id}`, 'PUT', { name: 'Renamed egress source' });
  await stopApp(); await startApp();
  const renamed = await api('/generate/preview', 'POST', { profileId: profile.id, customType: 'singbox' });
  assert.equal(renamed.success, true, JSON.stringify(renamed));
  const renamedDoc = JSON.parse(renamed.data);
  assert.equal(renamedDoc.dns.servers.find((entry: any) => entry.server === 'dns.egress.example').detour, 'Renamed stable exit');
  assert.equal((await source(added.data.id)).doh.services[0].outbound.nodeId, exitId);
});

test('an adopted source node resolving through itself fails with a concrete cycle in both HTTP outputs', async () => {
  bodies.set('/cycle', JSON.stringify({ outbounds: [{ type: 'socks', tag: 'Circular exit', server: 'node.circular.example', server_port: 1080 }], dns: { servers: [{ type: 'https', server: 'dns.circular.example', detour: 'Circular exit' }] } }));
  const added = await api('/sources', 'POST', { name: 'Circular source', url: upstreamOrigin + '/cycle' });
  const profile = await profileFor([added.data]);
  const preview = await api('/generate/preview', 'POST', { profileId: profile.id, customType: 'singbox' });
  assert.equal(preview.status, 422);
  const diagnostic = preview.generation.diagnostics.find((entry: any) => entry.code === 'source-doh-cycle');
  assert.ok(diagnostic, JSON.stringify(preview));
  assert.match(diagnostic.message, /Circular exit.*dns.circular.example.*Circular exit/);
  assert.ok(diagnostic.path.length >= 3);
  const actual = await fetch(`${origin}/s/${profile.token}/singbox`);
  assert.equal(actual.status, 422);
  assert.deepEqual((await actual.json() as any).generation, preview.generation);
});

test('every selectable source-private group member is checked instead of pruning its cyclic member', async () => {
  bodies.set('/group-cycle', JSON.stringify({ outbounds: [
    { type: 'socks', tag: 'Cycle through group', server: 'node.group-cycle.example', server_port: 1080 },
    { type: 'direct', tag: 'Safe direct' },
    { type: 'selector', tag: 'Inner choice', outbounds: ['Safe direct', 'Cycle through group'], default: 'Safe direct' },
    { type: 'selector', tag: 'DNS choice', outbounds: ['Inner choice'] },
  ], dns: { servers: [{ type: 'https', server: '192.0.2.53', detour: 'DNS choice' }] } }));
  const added = await api('/sources', 'POST', { name: 'Group cycle source', url: upstreamOrigin + '/group-cycle' });
  assert.equal(added.success, true, added.message);
  const profile = await profileFor([added.data]);
  const preview = await api('/generate/preview', 'POST', { profileId: profile.id, customType: 'singbox' });
  assert.equal(preview.status, 422);
  const diagnostic = preview.generation.diagnostics.find((entry: any) => entry.code === 'source-doh-cycle');
  assert.ok(diagnostic, JSON.stringify(preview));
  assert.match(diagnostic.message, /Cycle through group.*192.0.2.53.*DNS choice.*Inner choice.*Cycle through group/);
});

test('a missing necessary node detour is a repair error instead of silent direct fallback', async () => {
  bodies.set('/missing-detour', JSON.stringify({ outbounds: [{ type: 'socks', tag: 'Missing detour node', server: 'node.missing-detour.example', server_port: 1080, detour: 'Deleted upstream hop' }], dns: { servers: [{ type: 'https', server: '192.0.2.53' }] } }));
  const added = await api('/sources', 'POST', { name: 'Missing detour source', url: upstreamOrigin + '/missing-detour' });
  const profile = await profileFor([added.data]);
  const preview = await api('/generate/preview', 'POST', { profileId: profile.id, customType: 'singbox' });
  assert.equal(preview.status, 422);
  assert.ok(preview.generation.diagnostics.some((entry: any) => entry.code === 'source-doh-dependency-missing' && /Deleted upstream hop/.test(entry.message)));
});

test('template bootstrap egress is checked through its actual selectors and source binding', async () => {
  const added = await addSource('/template-cycle', [{ type: 'https', server: 'dns.template-cycle.example' }], 'node.template-cycle.example');
  const content = structuredClone(template);
  (content.dns.servers[0] as any).detour = 'Template DNS exit';
  (content.outbounds as any[]).push({ type: 'selector', tag: 'Template DNS exit', outbounds: ['Shared'] });
  const profile = await profileFor([added], content);
  const preview = await api('/generate/preview', 'POST', { profileId: profile.id, customType: 'singbox' });
  assert.equal(preview.status, 422);
  const diagnostic = preview.generation.diagnostics.find((entry: any) => entry.code === 'source-doh-cycle');
  assert.ok(diagnostic, JSON.stringify(preview));
  assert.match(diagnostic.message, /Shared.*dns.template-cycle.example.*127.0.0.1.*Template DNS exit.*Shared/);
});

test('IP-addressed nodes never start their unused broken source DNS chain and unrelated profiles still work', async () => {
  const added = await addSource('/ip-unused', [{ type: 'https', server: 'dns.unused.example', detour: 'Missing unused exit' }], '192.0.2.90');
  const profile = await profileFor([added]);
  const preview = await api('/generate/preview', 'POST', { profileId: profile.id, customType: 'singbox' });
  assert.equal(preview.success, true, JSON.stringify(preview));
  assert.equal(preview.generation.bindings[0].method, 'ip-node-no-dns');
  assert.equal(JSON.parse(preview.data).dns.servers.some((entry: any) => entry.server === 'dns.unused.example'), false);
  const safe = await addSource('/unrelated', [{ type: 'https', server: '192.0.2.53' }], 'node.unrelated.example');
  const unrelated = await profileFor([safe]);
  assert.equal((await api('/generate/preview', 'POST', { profileId: unrelated.id, customType: 'singbox' })).success, true);
});

test('source-private node detours are emitted in their source namespace without changing original strategy options', async () => {
  bodies.set('/node-group-detour', JSON.stringify({ outbounds: [
    { type: 'socks', tag: 'Chained node', server: 'node.private-detour.example', server_port: 1080, detour: 'Private chain' },
    { type: 'selector', tag: 'Private chain', outbounds: ['Private direct'], interrupt_exist_connections: true },
    { type: 'direct', tag: 'Private direct' },
  ], dns: { servers: [{ type: 'https', server: '192.0.2.53' }] } }));
  const added = await api('/sources', 'POST', { name: 'Private node detour', url: upstreamOrigin + '/node-group-detour' });
  const profile = await profileFor([added.data]);
  const preview = await api('/generate/preview', 'POST', { profileId: profile.id, customType: 'singbox' });
  assert.equal(preview.success, true, JSON.stringify(preview));
  const doc = JSON.parse(preview.data);
  const node = doc.outbounds.find((entry: any) => entry.server === 'node.private-detour.example');
  const strategy = doc.outbounds.find((entry: any) => entry.tag === node.detour);
  assert.equal(strategy.type, 'selector');
  assert.equal(strategy.interrupt_exist_connections, true);
  assert.equal(doc.outbounds.find((entry: any) => entry.tag === strategy.outbounds[0]).type, 'direct');
});

test('native Mihomo bare DoH defaults follow its DNS field and respect-rules semantics', async () => {
  const definitions = [
    ['bare-direct', 'nameserver', false, 'applied'],
    ['bare-routed', 'nameserver', true, 'unapplied'],
    ['bare-proxy-dns', 'proxy-server-nameserver', true, 'applied'],
  ];
  for (const [name, field, respectRules, expected] of definitions) {
    bodies.set(`/${name}`, `proxies:\n - {name: ${name}, type: ss, server: ${name}.example, port: 443, cipher: aes-128-gcm, password: dummy}\ndns:\n respect-rules: ${respectRules}\n ${field}: ['https://dns.${name}.example/query']\n`);
    const added = await api('/sources', 'POST', { name, url: upstreamOrigin + '/' + name });
    const profile = await profileFor([added.data]);
    const preview = await api('/generate/preview', 'POST', { profileId: profile.id, customType: 'singbox' });
    assert.equal(preview.success, true, JSON.stringify(preview));
    assert.equal(preview.generation.bindings[0].status, expected, String(name));
    if (expected === 'applied') assert.equal(JSON.parse(preview.data).dns.servers.find((entry: any) => entry.server === `dns.${name}.example`).detour, undefined);
    else assert.equal(preview.generation.diagnostics[0].code, 'source-doh-egress-unapplied');
  }
});

test('safe generated native proxy DoH egress passes sing-box check and bounded process startup', { skip: !process.env.SUBONE_SINGBOX_BINARY }, async () => {
  bodies.set('/native-private-egress', JSON.stringify({ outbounds: [
    { type: 'socks', tag: 'Native node', server: 'node.native-egress.example', server_port: 1080 },
    { type: 'socks', tag: 'Native exit', server: '127.0.0.1', server_port: 45431 },
    { type: 'selector', tag: 'Private selector', outbounds: ['Native exit'] },
  ], dns: { servers: [{ type: 'https', server: 'dns.native-egress.example', detour: 'Private selector' }] } }));
  const added = await api('/sources', 'POST', { name: 'Native private egress', url: upstreamOrigin + '/native-private-egress' });
  const profile = await profileFor([added.data]);
  const response = await fetch(`${origin}/s/${profile.token}/singbox`);
  assert.equal(response.status, 200);
  const output = await response.text();
  const path = join(directory, 'native-egress.json');
  await writeFile(path, output);
  if (process.env.SUBONE_GENERATION_CONFIG20) await writeFile(process.env.SUBONE_GENERATION_CONFIG20, output);
  const check = spawnSync(process.env.SUBONE_SINGBOX_BINARY!, ['check', '-c', path], { encoding: 'utf8', timeout: 5000 });
  assert.equal(check.status, 0, check.stderr);
  const startup = spawnSync(process.env.SUBONE_SINGBOX_BINARY!, ['run', '-c', path], { encoding: 'utf8', timeout: 1000 });
  assert.ok(startup.error && 'code' in startup.error, startup.stderr);
  assert.equal(startup.error.code, 'ETIMEDOUT', startup.stderr);
  assert.doesNotMatch(startup.stderr, /FATAL/);
});

test('unknown dynamic strategy members remain an honest capacity diagnostic without a same-name global substitute', async () => {
  bodies.set('/dynamic-private', `proxies:\n - {name: Dynamic node, type: ss, server: node.dynamic.example, port: 443, cipher: aes-128-gcm, password: dummy}\nproxy-groups:\n - {name: DNS strategy, type: select, proxies: [DIRECT], use: [unknown-provider], filter: Exit}\ndns:\n nameserver: ['https://dns.dynamic.example/query#DNS strategy']\n`);
  const added = await api('/sources', 'POST', { name: 'Dynamic private', url: upstreamOrigin + '/dynamic-private' });
  assert.equal(added.success, true, added.message);
  await api('/groups', 'POST', { name: 'DNS strategy', type: 'direct' });
  const profile = await profileFor([added.data]);
  const preview = await api('/generate/preview', 'POST', { profileId: profile.id, customType: 'singbox' });
  assert.equal(preview.success, true, JSON.stringify(preview));
  assert.equal(preview.generation.bindings[0].status, 'unapplied');
  assert.equal(preview.generation.diagnostics[0].code, 'source-doh-strategy-unapplied');
  assert.equal(JSON.parse(preview.data).dns.servers.some((entry: any) => entry.server === 'dns.dynamic.example'), false);
  assert.deepEqual((await source(added.data.id)).doh, added.data.doh);
  const unsupported = await api('/generate/preview', 'POST', { profileId: profile.id, customType: 'quantumultx' });
  assert.equal(unsupported.success, true);
  assert.equal(unsupported.generation.diagnostics[0].code, 'source-doh-node-resolver-unverified');
});

test('recursive source bootstrap cycles preserve both private resolvers in the concrete dependency chain', async () => {
  const added = await addSource('/recursive-bootstrap-cycle', [
    { type: 'udp', tag: 'First bootstrap', server: 'first.bootstrap.example', domain_resolver: { server: 'Second bootstrap' } },
    { type: 'tls', tag: 'Second bootstrap', server: 'second.bootstrap.example', domain_resolver: { server: 'First bootstrap' } },
    { type: 'https', server: 'dns.recursive.example', domain_resolver: { server: 'First bootstrap' } },
  ], 'node.recursive.example');
  const profile = await profileFor([added]);
  const preview = await api('/generate/preview', 'POST', { profileId: profile.id, customType: 'singbox' });
  assert.equal(preview.status, 422);
  assert.match(preview.generation.diagnostics.find((entry: any) => entry.code === 'source-doh-cycle').message, /dns.recursive.example.*first.bootstrap.example.*second.bootstrap.example.*first.bootstrap.example/);
});

test('final Relay clones participate in the adopted DNS bootstrap graph with their actual detour and resolver', async () => {
  bodies.set('/final-relay-cycle', JSON.stringify({ outbounds: [
    { type: 'socks', tag: 'Entry IP', server: '192.0.2.70', server_port: 1080 },
    { type: 'socks', tag: 'Relay domain', server: 'relay.domain.example', server_port: 1080 },
  ], dns: { servers: [{ type: 'https', server: 'dns.relay-cycle.example' }] } }));
  const added = await api('/sources', 'POST', { name: 'Relay cycle', url: upstreamOrigin + '/final-relay-cycle' });
  const relay = (await api('/groups', 'POST', { name: 'Final runtime relay', type: 'relay', proxies: added.data.nodes.map((node: any) => `node:${node.id}`) })).data;
  const content = structuredClone(template);
  (content.dns.servers[0] as any).detour = relay.name;
  const profile = await profileFor([added.data], content);
  await api(`/profiles/${profile.id}`, 'PUT', { selectedGroupIds: [relay.id] });
  const preview = await api('/generate/preview', 'POST', { profileId: profile.id, customType: 'singbox' });
  assert.equal(preview.status, 422);
  assert.match(preview.generation.diagnostics.find((entry: any) => entry.code === 'source-doh-cycle').message, /dns.relay-cycle.example.*127.0.0.1.*Final runtime relay/);
});

test('generated Relay connection clones never enter automatic ordinary group candidates', async () => {
  bodies.set('/relay-candidates', JSON.stringify({ outbounds: [
    { type: 'socks', tag: 'Candidate one', server: '192.0.2.71', server_port: 1080 },
    { type: 'socks', tag: 'Candidate two', server: '192.0.2.72', server_port: 1080 },
    { type: 'socks', tag: 'Candidate three', server: '192.0.2.73', server_port: 1080 },
  ] }));
  const added = await api('/sources', 'POST', { name: 'Relay candidates', url: upstreamOrigin + '/relay-candidates' });
  const relay = (await api('/groups', 'POST', { name: 'Three hop relay', type: 'relay', proxies: added.data.nodes.map((node: any) => `node:${node.id}`) })).data;
  const profile = await profileFor([added.data]);
  await api(`/profiles/${profile.id}`, 'PUT', { selectedGroupIds: [relay.id, ...profile.selectedGroupIds] });
  const preview = await api('/generate/preview', 'POST', { profileId: profile.id, customType: 'singbox' });
  assert.equal(preview.success, true, JSON.stringify(preview));
  const doc = JSON.parse(preview.data);
  const automatic = doc.outbounds.find((entry: any) => entry.tag.startsWith('Candidates-'));
  assert.deepEqual(automatic.outbounds, ['Candidate one', 'Candidate two', 'Candidate three']);
});

test('an adopted mounted strategy with no available members cannot silently become direct', async () => {
  const ordinary = await addSource('/empty-egress-ordinary', [{ type: 'https', server: 'dns.empty-egress.example' }], 'node.empty-egress.example');
  const exit = await addSource('/empty-egress-exit', [], '192.0.2.99');
  const group = (await api('/groups', 'POST', { name: 'Required mounted exit', type: 'select', sources: [exit.id] })).data;
  await api(`/sources/${exit.id}`, 'PUT', { enabled: false });
  const content = structuredClone(template);
  (content.dns.servers[0] as any).detour = group.name;
  content.outbounds = [];
  content.route.rules = [];
  const profile = await profileFor([ordinary], content);
  await api(`/profiles/${profile.id}`, 'PUT', { selectedGroupIds: [group.id, ...profile.selectedGroupIds] });
  const preview = await api('/generate/preview', 'POST', { profileId: profile.id, customType: 'singbox' });
  assert.equal(preview.status, 422);
  assert.ok(preview.generation.diagnostics.some((entry: any) => entry.code === 'source-doh-dependency-missing' && /Required mounted exit/.test(entry.message)));
});

test('unapplied DoH capacity retains independently supported source-private node detours', async () => {
  bodies.set('/private-detour-unapplied-dns', JSON.stringify({ outbounds: [
    { type: 'socks', tag: 'Independent detour node', server: 'node.independent-detour.example', server_port: 1080, detour: 'Independent private selector' },
    { type: 'selector', tag: 'Independent private selector', outbounds: ['Independent direct'] },
    { type: 'direct', tag: 'Independent direct' },
  ], dns: { servers: [{ type: 'dhcp', tag: 'Unsupported source bootstrap' }, { type: 'https', server: 'dns.unsupported-bootstrap.example', domain_resolver: { server: 'Unsupported source bootstrap' } }] } }));
  const added = await api('/sources', 'POST', { name: 'Independent node detour', url: upstreamOrigin + '/private-detour-unapplied-dns' });
  assert.equal(added.success, true, added.message);
  const profile = await profileFor([added.data]);
  const preview = await api('/generate/preview', 'POST', { profileId: profile.id, customType: 'singbox' });
  assert.equal(preview.success, true, JSON.stringify(preview));
  assert.equal(preview.generation.bindings[0].status, 'unapplied');
  assert.equal(preview.generation.diagnostics[0].code, 'source-doh-bootstrap-unapplied');
  const doc = JSON.parse(preview.data);
  const node = doc.outbounds.find((entry: any) => entry.server === 'node.independent-detour.example');
  assert.equal(doc.outbounds.find((entry: any) => entry.tag === node.detour).type, 'selector');
  assert.equal(node.domain_resolver, undefined);
});

test('an IP-addressed DoH endpoint does not acquire a runtime edge to its unused hostname resolver', async () => {
  const added = await addSource('/ip-doh-unused-resolver', [{ type: 'https', tag: 'Unused self lookup', server: '192.0.2.53', domain_resolver: { server: 'Unused self lookup' } }], 'node.ip-doh.example');
  const profile = await profileFor([added]);
  const preview = await api('/generate/preview', 'POST', { profileId: profile.id, customType: 'singbox' });
  assert.equal(preview.success, true, JSON.stringify(preview));
  assert.equal(preview.generation.bindings[0].status, 'applied');
  if (process.env.SUBONE_SINGBOX_BINARY) {
    const path = join(directory, 'ip-doh-unused-resolver.json');
    await writeFile(path, preview.data);
    const check = spawnSync(process.env.SUBONE_SINGBOX_BINARY, ['check', '-c', path], { encoding: 'utf8', timeout: 5000 });
    assert.equal(check.status, 0, check.stderr);
    const startup = spawnSync(process.env.SUBONE_SINGBOX_BINARY, ['run', '-c', path], { encoding: 'utf8', timeout: 1000 });
    assert.equal(startup.error && 'code' in startup.error ? startup.error.code : undefined, 'ETIMEDOUT', startup.stderr);
    assert.doesNotMatch(startup.stderr, /FATAL/);
  }
});

test('template-owned IP resolver constructor cycles are diagnosed without rewriting saved template fields', async () => {
  const added = await addSource('/template-ip-constructor-cycle', [{ type: 'https', server: 'dns.template-constructor.example' }], 'node.template-constructor.example');
  const content = structuredClone(template);
  (content.dns.servers[0] as any).domain_resolver = { server: 'bootstrap' };
  const profile = await profileFor([added], content);
  const preview = await api('/generate/preview', 'POST', { profileId: profile.id, customType: 'singbox' });
  assert.equal(preview.status, 422);
  assert.match(preview.generation.diagnostics.find((entry: any) => entry.code === 'source-doh-cycle').message, /dns.template-constructor.example.*127.0.0.1.*127.0.0.1/);
  const saved = (await api('/templates')).data.find((entry: any) => entry.id === profile.templates.singbox);
  assert.equal(saved.content, JSON.stringify(content));
});

test('source selector connection fields unsupported by native sing-box remain an explicit capability diagnostic', async () => {
  bodies.set('/unsupported-selector-field', JSON.stringify({ outbounds: [
    { type: 'socks', tag: 'Unsupported selector node', server: 'node.selector-options.example', server_port: 1080 },
    { type: 'direct', tag: 'Private direct' },
    { type: 'selector', tag: 'Unsupported detoured selector', outbounds: ['Private direct'], detour: 'Private direct' },
  ], dns: { servers: [{ type: 'https', server: '192.0.2.53', detour: 'Unsupported detoured selector' }] } }));
  const added = await api('/sources', 'POST', { name: 'Unsupported selector field', url: upstreamOrigin + '/unsupported-selector-field' });
  const profile = await profileFor([added.data]);
  const preview = await api('/generate/preview', 'POST', { profileId: profile.id, customType: 'singbox' });
  assert.equal(preview.success, true, JSON.stringify(preview));
  assert.equal(preview.generation.bindings[0].status, 'unapplied');
  assert.equal(preview.generation.diagnostics[0].code, 'source-doh-strategy-unapplied');
});

test('only the adopted first DoH service contributes necessary runtime dependencies', async () => {
  for (const brokenFirst of [false, true]) {
    const services = [{ type: 'https', server: '192.0.2.53' }, { type: 'https', server: '192.0.2.54', detour: 'Unused or broken exit' }];
    if (brokenFirst) services.reverse();
    const added = await addSource(`/first-service-${brokenFirst}`, services, `node.first-service-${brokenFirst}.example`);
    const profile = await profileFor([added]);
    const preview = await api('/generate/preview', 'POST', { profileId: profile.id, customType: 'singbox' });
    if (brokenFirst) {
      assert.equal(preview.status, 422);
      assert.equal(preview.generation.diagnostics[0].code, 'source-doh-dependency-missing');
    } else {
      assert.equal(preview.success, true, JSON.stringify(preview));
      assert.equal(preview.generation.bindings[0].status, 'degraded');
      assert.deepEqual(JSON.parse(preview.data).dns.servers.filter((entry: any) => entry.tag.startsWith('subone-doh-')).map((entry: any) => entry.server), ['192.0.2.53']);
    }
  }
});
