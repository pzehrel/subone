import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import yaml from 'js-yaml';

let directory: string;
let child: ChildProcess;
let origin: string;
let upstreamOrigin: string;
const bodies = new Map<string, string>();
const userinfo = new Map<string, string>();
const upstream = createServer((request, response) => {
  const usage = userinfo.get(request.url || '/'); if (usage) response.setHeader('Subscription-Userinfo', usage);
  response.end(bodies.get(request.url || '/') || 'proxies: []');
});
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
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'subone-egern-http-'));
  await writeFile(join(directory, 'config.json'), JSON.stringify({ port: 3456, adminPassword: '' }));
  await cp(join(__dirname, '../../../templates'), join(directory, 'templates'), { recursive: true });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const address = upstream.address(); assert.ok(address && typeof address !== 'string');
  upstreamOrigin = `http://127.0.0.1:${address.port}`; await startApp();
});
after(async () => { await stopApp(); await new Promise<void>(resolve => upstream.close(() => resolve())); await rm(directory, { recursive: true, force: true }); });

const nativeTemplate = {
  ipv6: false, http_port: 8081,
  dns: { bootstrap: ['127.0.0.1'], upstreams: { ordinary: ['https://template.dns.example/query', 'tls://template.dot.example'] }, forward: [{ domain_suffix: { match: 'kept.example', value: 'ordinary' } }] },
  proxies: [{ socks5: { name: 'Template node', server: '192.0.2.90', port: 1080 } }],
  policy_groups: [{ select: { name: 'Template group', policies: ['Template node', 'DIRECT'] } }],
  rules: [{ domain: { match: 'kept.example', policy: 'Template group' } }, { default: { policy: 'DIRECT' } }],
};
async function addSource(path: string, proxies: any[], doh = ['https://first.dns.example/query#DIRECT', 'https://second.dns.example/query#DIRECT']) {
  bodies.set(path, yaml.dump({ proxies, dns: { nameserver: doh } }));
  const response = await api('/sources', 'POST', { name: path.slice(1), url: upstreamOrigin + path });
  assert.equal(response.success, true, response.message); return response.data;
}
async function profileFor(source: any, groups: any[] = [{ name: `Candidates-${Math.random()}`, type: 'select', sources: [source.id] }], content = nativeTemplate) {
  const savedGroups = [];
  for (const group of groups) {
    const response = await api('/groups', 'POST', group); assert.equal(response.success, true, response.message); savedGroups.push(response.data);
  }
  const rule = (await api('/rules/unified', 'POST', { name: 'Egern domain', kind: 'local', type: 'DOMAIN-SUFFIX', payload: 'native.example', outbound: savedGroups[0].name, enabled: true })).data;
  const tplResponse = await api('/templates', 'POST', { name: 'Native Egern template', type: 'egern', content: yaml.dump(content) });
  assert.equal(tplResponse.success, true, tplResponse.message); const tpl = tplResponse.data;
  const profile = (await api('/profiles', 'POST', { name: 'Egern profile', nodeFilter: { mode: 'all', sourceIds: [source.id] }, selectedGroupIds: savedGroups.map(group => group.id), selectedRuleIds: [rule.id], templates: { egern: tpl.id } })).data;
  return { profile, groups: savedGroups, template: tpl, rule };
}
async function preview(profile: any, expandNodes = true) { return api('/generate/preview', 'POST', { profileId: profile.id, customType: 'egern', expandNodes }); }
const typedValues = (entries: any[]) => entries.map(entry => Object.values(entry)[0] as any);
function assertNativeReferences(doc: any) {
  const nodes = typedValues(doc.proxies); const groups = typedValues(doc.policy_groups);
  const names = new Set(['DIRECT', 'REJECT', ...nodes.map(node => node.name), ...groups.map(group => group.name)]);
  assert.equal(names.size, nodes.length + groups.length + 2, 'native names are globally unique');
  for (const group of groups) for (const name of group.policies || []) assert.ok(names.has(name), `missing policy ${name}`);
  for (const node of nodes) if (node.prev_hop) assert.ok(names.has(node.prev_hop), `missing prev_hop ${node.prev_hop}`);
  for (const rule of typedValues(doc.rules)) assert.ok(names.has(rule.policy), `missing rule policy ${rule.policy}`);
  assert.equal(doc['proxy-groups'], undefined); assert.equal(doc.sources, undefined);
  assert.equal(doc.dns?.['proxy-server-nameserver-policy'], undefined);
}

test('the packaged Egern workflow generates native groups and protected providers for all default remote rules', async () => {
  await addSource('/default-native', [{ name: 'HK Default', type: 'socks5', server: 'default.native.example', port: 1080 }], []);
  const profile = (await api('/profiles')).data.find((profile: any) => profile.id === 'prof_default');
  const result = await preview(profile); assert.equal(result.success, true, result.message);
  const doc: any = yaml.load(result.data); assertNativeReferences(doc);
  assert.deepEqual(doc.dns, { bootstrap: ['223.5.5.5', '119.29.29.29'] });
  const remote = (await api('/rules/unified')).data.filter((rule: any) => rule.enabled && rule.kind === 'remote');
  const declaredDomain = remote.find((rule: any) => rule.payload.includes('SagerNet/sing-geosite/')); const declaredIp = remote.find((rule: any) => rule.payload.includes('SagerNet/sing-geoip/'));
  assert.match(declaredDomain.payload, /SagerNet\/sing-geosite/); assert.equal(declaredDomain.clientUrls.egern, 'https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/sing/geo/geosite/cn.json');
  assert.match(declaredIp.payload, /SagerNet\/sing-geoip/); assert.equal(declaredIp.clientUrls.egern, 'https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/sing/geo/geoip/cn.json');
  const urls = doc.rules.filter((entry: any) => entry.rule_set).map((entry: any) => entry.rule_set.match);
  assert.equal(urls.length, remote.length);
  for (const rule of remote) assert.ok(urls.includes(`${origin}/s/${profile.token}/rules/${rule.id}/egern`));
  assert.doesNotMatch(result.data, /\.srs|proxy-groups|filter-sources/);
  if (process.env.SUBONE_GENERATION_CONFIG25) await writeFile(process.env.SUBONE_GENERATION_CONFIG25, result.data);
  assert.deepEqual(doc.policy_groups.find((entry: any) => entry.auto_test?.name === '🇯🇵 日本节点').auto_test.policies, ['DIRECT']);
  const actual = await fetch(`${origin}/s/${profile.token}/egern?expand=true`); assert.equal(actual.status, 200); assert.equal(await actual.text(), result.data);
  if (process.env.SUBONE_EGERN_RULES_VERIFY) for (const url of urls) { const provider = await fetch(url); assert.equal(provider.status, 200, url); const data: any = yaml.load(await provider.text()); assert.ok(Object.keys(data).some(key => key.endsWith('_set')), url); }
});

test('Egern HTTP output uses native typed nodes, groups and rules with native source DNS forwarding', async () => {
  const source = await addSource('/native-four', [
    { name: 'SS', type: 'ss', server: 'ss.native.example', port: 8388, cipher: 'aes-256-gcm', password: 'dummy', udp: true },
    { name: 'SOCKS', type: 'socks5', server: 'socks.native.example', port: 1080, username: 'user', password: 'dummy' },
    { name: 'VMess', type: 'vmess', server: 'vmess.native.example', port: 443, uuid: '11111111-1111-4111-8111-111111111111', cipher: 'auto', tls: true, servername: 'tls.native.example', 'skip-cert-verify': false },
    { name: 'Trojan', type: 'trojan', server: 'trojan.native.example', port: 443, password: 'dummy', sni: 'trojan.tls.example', 'skip-cert-verify': true },
  ]);
  const { profile, groups } = await profileFor(source, [{ name: 'Native Auto', type: 'urltest', sources: [source.id], interval: 120, tolerance: 20, url: 'https://latency.example/check' }]);
  const result = await preview(profile);
  assert.equal(result.success, true, result.message);
  assert.equal(result.generation.target.version, '2.21.0');
  const doc: any = yaml.load(result.data);
  assert.deepEqual(doc.dns.bootstrap, nativeTemplate.dns.bootstrap);
  assert.deepEqual(doc.dns.upstreams.ordinary, nativeTemplate.dns.upstreams.ordinary);
  assert.deepEqual(doc.dns.forward.at(-1), nativeTemplate.dns.forward[0]); assert.equal(doc.http_port, 8081);
  assert.deepEqual(doc.proxies.find((entry: any) => entry.shadowsocks)?.shadowsocks, { name: 'SS', server: 'ss.native.example', port: 8388, method: 'aes-256-gcm', password: 'dummy', udp_relay: true });
  assert.deepEqual(doc.proxies.find((entry: any) => entry.socks5?.server === 'socks.native.example')?.socks5, { name: 'SOCKS', server: 'socks.native.example', port: 1080, username: 'user', password: 'dummy', udp_relay: true });
  assert.deepEqual(doc.proxies.find((entry: any) => entry.vmess)?.vmess, { name: 'VMess', server: 'vmess.native.example', port: 443, user_id: '11111111-1111-4111-8111-111111111111', security: 'auto', udp_relay: true, transport: { tls: { sni: 'tls.native.example', skip_tls_verify: false } } });
  assert.deepEqual(doc.proxies.find((entry: any) => entry.trojan)?.trojan, { name: 'Trojan', server: 'trojan.native.example', port: 443, password: 'dummy', sni: 'trojan.tls.example', skip_tls_verify: true, udp_relay: true });
  assert.deepEqual(doc.proxies[0], nativeTemplate.proxies[0]);
  assert.deepEqual(doc.policy_groups[0], nativeTemplate.policy_groups[0]);
  assert.deepEqual(doc.policy_groups.find((entry: any) => entry.auto_test?.name === groups[0].name), { auto_test: { name: groups[0].name, policies: ['SS', 'SOCKS', 'VMess', 'Trojan'], interval: 120, tolerance: 20, latency_test_url: 'https://latency.example/check' } });
  assert.deepEqual(doc.rules, [nativeTemplate.rules[0], { domain_suffix: { match: 'native.example', policy: groups[0].name } }, nativeTemplate.rules[1]]);
  assertNativeReferences(doc);
  const binding = result.generation.bindings[0];
  assert.equal(binding.status, 'applied'); assert.deepEqual(binding.appliedServiceIds, source.doh.services.map((entry: any) => entry.id));
  assert.equal(binding.batchId, source.doh.batchId); assert.deepEqual(binding.services.map((service: any) => service.url), ['https://first.dns.example/query', 'https://second.dns.example/query']);
  assert.equal(binding.diagnostics.length, 0);
  assert.ok(doc.dns.forward.some((rule: any) => rule.domain_wildcard?.match === '*.native.example'));
  const actual = await fetch(`${origin}/s/${profile.token}/egern?expand=true`); assert.equal(actual.status, 200); assert.equal(await actual.text(), result.data);
  await stopApp(); await startApp();
  assert.equal((await preview(profile)).data, result.data);
  assert.deepEqual((await api('/sources')).data.find((entry: any) => entry.id === source.id).doh, source.doh);
});

test('native provider mounts share profile selection, names and source lifecycle without adopting multi-source DNS', async () => {
  const a = await addSource('/provider-a', [
    { name: 'Shared', type: 'socks5', server: 'a.provider.example', port: 1080 },
    { name: 'Disabled', type: 'ss', server: 'disabled.provider.example', port: 443, cipher: 'aes-128-gcm', password: 'dummy' },
    { name: 'Excluded', type: 'ss', server: 'excluded.provider.example', port: 443, cipher: 'aes-128-gcm', password: 'dummy' },
  ], ['https://a.dns.example/first#Shared', 'https://a.dns.example/second#DIRECT']);
  const b = await addSource('/provider-b', [{ name: 'Shared', type: 'socks5', server: 'b.provider.example', port: 1081 }], ['https://b.dns.example/query#DIRECT']);
  assert.equal((await api(`/nodes/${a.nodes[1].id}`, 'PUT', { enabled: false })).success, true);
  const { profile, groups } = await profileFor(a, [{ name: 'Provider group', type: 'select', sources: [a.id, b.id] }]);
  assert.equal((await api(`/profiles/${profile.id}`, 'PUT', { nodeFilter: { mode: 'all', sourceIds: [a.id, b.id], excludeKeywords: ['Excluded'] } })).success, true);
  const result = await preview(profile, false); assert.equal(result.success, true, result.message);
  const doc: any = yaml.load(result.data); assertNativeReferences(doc);
  const group = typedValues(doc.policy_groups).find(group => group.name === groups[0].name);
  assert.equal(group.urls.length, 2);
  assert.ok(group.urls.every((url: string) => url.startsWith(`${origin}/s/${profile.token}/source/`)));
  const providers: any[] = [];
  for (const url of group.urls) {
    const response = await fetch(url); assert.equal(response.status, 200);
    const provider: any = yaml.load(await response.text()); assert.deepEqual(Object.keys(provider), ['proxies']);
    providers.push(...typedValues(provider.proxies));
  }
  assert.deepEqual(new Set(providers.map(node => node.server)), new Set(['a.provider.example', 'b.provider.example']));
  assert.equal(new Set(providers.map(node => node.name)).size, 2);
  for (const node of providers) assert.ok(typedValues(doc.proxies).some(full => full.name === node.name && full.server === node.server));
  assert.deepEqual(result.generation.bindings.map((binding: any) => [binding.sourceId, binding.status, binding.appliedServiceIds]), [[a.id, 'unapplied', []], [b.id, 'applied', b.doh.services.map((entry: any) => entry.id)]]);
  assert.deepEqual(doc.dns.bootstrap, nativeTemplate.dns.bootstrap);
  assert.deepEqual(doc.dns.upstreams.ordinary, nativeTemplate.dns.upstreams.ordinary);
  assert.deepEqual(doc.dns.forward.at(-1), nativeTemplate.dns.forward[0]);
  assert.equal(await fetch(`${origin}/s/${profile.token}/egern?expand=false`).then(response => response.text()), result.data);
  const previousOrigin = origin; await stopApp(); await startApp();
  assert.equal((await preview(profile, false)).data, result.data.replaceAll(previousOrigin, origin));
  assert.equal((await api(`/sources/${b.id}`, 'PUT', { enabled: false })).success, true);
  assert.equal((await fetch(`${origin}/s/${profile.token}/source/${b.id}?target=egern`)).status, 404);
  const disabled = await preview(profile, false); assert.equal(disabled.success, true, disabled.message);
  assert.doesNotMatch(disabled.data, /b\.provider\.example|b\.dns\.example/);
  assert.deepEqual(disabled.generation.bindings.map((binding: any) => binding.sourceId), [a.id]);
  bodies.set('/provider-a', yaml.dump({ proxies: [{ name: 'Upstream renamed', type: 'socks5', server: 'a.provider.example', port: 1080 }] }));
  assert.equal((await api(`/sources/${a.id}/refresh`, 'POST', {})).success, true);
  const removed = await preview(profile); assert.equal(removed.success, true, removed.message);
  assert.equal(removed.generation.bindings[0].status, 'template'); assert.deepEqual(removed.generation.bindings[0].services, []);
  assert.deepEqual((yaml.load(removed.data) as any).dns, nativeTemplate.dns);
  assert.equal((await api(`/sources/${a.id}`, 'DELETE')).success, true);
  assert.equal((await fetch(`${origin}/s/${profile.token}/source/${a.id}?target=egern`)).status, 404);
});

test('native template references and managed references follow stable renames without colliding with template or builtin names', async () => {
  const source = await addSource('/stable-native', [
    { name: 'Stable upstream', type: 'socks5', server: 'stable.native.example', port: 1080 },
    { name: 'Template node', type: 'socks5', server: 'collision.native.example', port: 1081 },
    { name: 'DIRECT', type: 'socks5', server: 'builtin.native.example', port: 1082 },
  ], []);
  const content = {
    ...nativeTemplate,
    proxies: [{ socks5: { ...nativeTemplate.proxies[0].socks5, prev_hop: 'Stable upstream' } }],
    policy_groups: [{ select: { name: 'Template group', policies: ['Template node', 'Stable upstream', 'Managed stable'] } }],
    rules: [{ domain: { match: 'stable-rule.example', policy: 'Stable upstream' } }, { default: { policy: 'Managed stable' } }],
  };
  const { profile, groups, template } = await profileFor(source, [{ name: 'Managed stable', type: 'select', proxies: [`node:${source.nodes[0].id}`, `node:${source.nodes[1].id}`, `node:${source.nodes[2].id}`] }], content as any);
  let result = await preview(profile); assert.equal(result.success, true, result.message);
  let doc: any = yaml.load(result.data); assertNativeReferences(doc);
  assert.equal(typedValues(doc.proxies).find(node => node.server === 'collision.native.example').name, 'Template node (2)');
  assert.match(typedValues(doc.proxies).find(node => node.server === 'builtin.native.example').name, /^DIRECT \(\d+\)$/);
  assert.equal((await api(`/nodes/${source.nodes[0].id}`, 'PUT', { name: 'Local renamed = US,1' })).success, true);
  assert.equal((await api(`/groups/${groups[0].id}`, 'PUT', { name: 'Template group' })).success, true);
  result = await preview(profile); assert.equal(result.success, true, result.message);
  doc = yaml.load(result.data); assertNativeReferences(doc);
  assert.equal(doc.proxies[0].socks5.prev_hop, 'Local renamed = US,1');
  assert.deepEqual(doc.policy_groups[0].select.policies, ['Template node', 'Local renamed = US,1', 'Template group (2)']);
  assert.equal(doc.rules.find((entry: any) => entry.domain)?.domain.policy, 'Local renamed = US,1');
  assert.equal(doc.rules.find((entry: any) => entry.default)?.default.policy, 'Template group (2)');
  assert.deepEqual(typedValues(doc.policy_groups).find(group => group.name === 'Template group (2)').policies, ['Local renamed = US,1', 'Template node (2)', typedValues(doc.proxies).find(node => node.server === 'builtin.native.example').name]);
  assert.equal((await api('/templates')).data.find((entry: any) => entry.id === template.id).content, yaml.dump(content));
  await stopApp(); await startApp();
  assert.equal((await preview(profile)).data, result.data);
  assert.equal((await api(`/nodes/${source.nodes[0].id}`, 'PUT', { enabled: false })).success, true);
  const disabled = await preview(profile); assert.equal(disabled.status, 422); assert.equal(disabled.generation.diagnostics.at(-1).code, 'egern-reference-missing');
  assert.equal((await fetch(`${origin}/s/${profile.token}/egern?expand=true`)).status, 422);
});

test('documented Egern protocols and transports keep their native authentication and connection fields', async () => {
  const source = await addSource('/native-transports', [
    { name: 'WSS VMess', type: 'vmess', server: 'vm.wss.example', port: 443, uuid: '11111111-1111-4111-8111-111111111111', cipher: 'chacha20-poly1305', tls: true, servername: 'vm.tls.example', network: 'ws', 'ws-opts': { path: '/vmess', headers: { Host: 'ws.host.example' } } },
    { name: 'WS Trojan', type: 'trojan', server: 'trojan.ws.example', port: 443, password: 'trojan-pass', sni: 'trojan.tls.example', network: 'ws', 'ws-opts': { path: '/trojan', headers: { Host: 'trojan.host.example' } } },
    { name: 'Reality VLESS', type: 'vless', server: 'vless.native.example', port: 443, uuid: '22222222-2222-4222-8222-222222222222', tls: true, flow: 'xtls-rprx-vision', servername: 'reality.host.example', 'reality-opts': { 'public-key': 'dummy-public-key', 'short-id': 'abcd' } },
    { name: 'Snell', type: 'snell', server: 'snell.native.example', port: 443, psk: 'snell-pass', version: 4, 'obfs-opts': { mode: 'tls', host: 'obfs.example' } },
    { name: 'AnyTLS', type: 'anytls', server: 'anytls.native.example', port: 443, password: 'any-pass', sni: 'any.tls.example' },
    { name: 'Hysteria2', type: 'hysteria2', server: 'hy2.native.example', port: 443, password: 'hy-pass', sni: 'hy.tls.example', obfs: 'salamander', 'obfs-password': 'obfs-pass', up: 20, ports: '443,2000-3000', 'hop-interval': '30' },
    { name: 'TUIC', type: 'tuic', server: 'tuic.native.example', port: 443, uuid: '33333333-3333-4333-8333-333333333333', password: 'tuic-pass', alpn: ['h3'], 'udp-relay-mode': 'quic' },
    { name: 'WireGuard', type: 'wireguard', server: 'wg.native.example', port: 51820, 'private-key': 'private', 'public-key': 'peer', ip: '172.16.0.2/32', ipv6: 'fd00::2/128', reserved: [1, 2, 3], mtu: 1280 },
    { name: 'HTTPS', type: 'http', server: 'http.native.example', port: 443, tls: true, username: 'user', password: 'http-pass', sni: 'http.tls.example' },
    { name: 'TLS SOCKS', type: 'socks5', server: 'socks.tls.example', port: 443, tls: true, username: 'user', password: 'socks-pass' },
  ], []);
  const { profile } = await profileFor(source);
  const result = await preview(profile); assert.equal(result.success, true, result.message);
  const doc: any = yaml.load(result.data); assertNativeReferences(doc);
  const find = (type: string) => doc.proxies.find((entry: any) => entry[type])?.[type];
  assert.deepEqual(find('vmess').transport, { wss: { path: '/vmess', headers: { Host: 'ws.host.example' }, sni: 'vm.tls.example', skip_tls_verify: false } });
  assert.equal(find('vmess').security, 'chacha20-poly1305');
  assert.deepEqual(find('trojan').websocket, { path: '/trojan', host: 'trojan.host.example' });
  assert.deepEqual(find('vless').transport, { tls: { sni: 'reality.host.example', reality: { public_key: 'dummy-public-key', short_id: 'abcd' } } });
  assert.equal(find('vless').flow, 'xtls-rprx-vision');
  assert.deepEqual(find('snell'), { name: 'Snell', server: 'snell.native.example', port: 443, psk: 'snell-pass', version: 4, udp_relay: true, obfs: 'tls', obfs_host: 'obfs.example' });
  assert.equal(find('anytls').skip_tls_verify, false, 'AnyTLS native default skips verification; source CA verification must remain explicit');
  assert.deepEqual(find('hysteria2'), { name: 'Hysteria2', server: 'hy2.native.example', port: 443, auth: 'hy-pass', sni: 'hy.tls.example', skip_tls_verify: false, obfs: 'salamander', obfs_password: 'obfs-pass', bandwidth: 20, port_hopping: '443,2000-3000', port_hopping_interval: 30 });
  assert.equal(find('tuic').uuid, '33333333-3333-4333-8333-333333333333'); assert.deepEqual(find('tuic').alpn, ['h3']); assert.equal(find('tuic').udp_relay_mode, 'quic'); assert.equal(find('tuic').udp_relay, undefined);
  assert.deepEqual(find('wireguard'), { name: 'WireGuard', server: 'wg.native.example', port: 51820, private_key: 'private', peer_public_key: 'peer', local_ipv4: '172.16.0.2/32', local_ipv6: 'fd00::2/128', reserved: [1, 2, 3], mtu: 1280 });
  assert.equal(find('https').sni, 'http.tls.example'); assert.equal(find('https').udp_relay, undefined);
  assert.equal(find('socks5_tls').password, 'socks-pass');
  assert.equal(await fetch(`${origin}/s/${profile.token}/egern?expand=true`).then(response => response.text()), result.data);
});

test('native strategy parameters, ordered multi-value rules, explicit Egern rule sets and usage remain effective', async () => {
  userinfo.set('/strategy-rules', 'upload=1024; download=2048; total=10240; expire=1893456000');
  const source = await addSource('/strategy-rules', [
    { name: 'HK chosen', type: 'socks5', server: 'hk.strategy.example', port: 1080 },
    { name: 'JP chosen', type: 'socks5', server: 'jp.strategy.example', port: 1081 },
    { name: '剩余流量：128 GB', type: 'socks5', server: 'info.strategy.example', port: 1082 },
  ], []);
  assert.equal((await api(`/sources/${source.id}`, 'PUT', { trafficNodeRegex: '剩余流量' })).success, true);
  const { profile, groups, rule } = await profileFor(source, [
    { name: 'Native failover', type: 'fallback', proxies: [`node:${source.nodes[1].id}`, `node:${source.nodes[0].id}`], interval: 60, url: 'https://health.example/check' },
    { name: 'Native round robin', type: 'load-balance', sources: [source.id], strategy: 'round-robin' },
    { name: 'Native HK regex', type: 'urltest', sources: [source.id], filter: '(?i)hk', tolerance: 15, interval: 0 },
    { name: 'Native direct', type: 'direct' }, { name: 'Native reject', type: 'reject' },
  ]);
  bodies.set('/native-rules.yaml', 'domain_suffix_set: [remote.example]\nip_cidr_set: [192.0.2.0/24]\n');
  const selectedRuleIds = [rule.id];
  for (const value of [
    { name: 'Egern multi domain', type: 'DOMAIN-SUFFIX', payload: 'alpha.example, beta.example', outbound: groups[0].name },
    { name: 'Egern multi IP', type: 'IP-CIDR', payload: '192.0.2.0/24; 2001:db8::/32', outbound: 'DIRECT' },
    { name: 'Egern native remote', kind: 'remote', type: 'RULE-SET', payload: 'https://unrelated.example/original.srs', clientUrls: { egern: `${upstreamOrigin}/native-rules.yaml` }, outbound: groups[1].name },
    { name: 'Egern final', type: 'FINAL', payload: '', outbound: groups[1].name },
  ]) {
    const response = await api('/rules/unified', 'POST', { kind: 'local', enabled: true, ...value }); assert.equal(response.success, true, response.message); selectedRuleIds.push(response.data.id);
    if ('clientUrls' in value) assert.equal((await api(`/rules/unified/${response.data.id}`, 'PUT', { clientUrls: value.clientUrls })).success, true);
  }
  await api(`/profiles/${profile.id}`, 'PUT', { selectedRuleIds });
  const result = await preview(profile); assert.equal(result.success, true, result.message);
  const doc: any = yaml.load(result.data); assertNativeReferences(doc);
  assert.doesNotMatch(result.data, /info\.strategy\.example|剩余流量/);
  const find = (type: string, name: string) => doc.policy_groups.find((entry: any) => entry[type]?.name === name)?.[type];
  assert.deepEqual(find('fallback', groups[0].name), { name: groups[0].name, policies: ['JP chosen', 'HK chosen'], interval: 60, latency_test_url: 'https://health.example/check' });
  assert.equal(find('load_balance', groups[1].name).algorithm, 'round_robin');
  assert.deepEqual(find('auto_test', groups[2].name).policies, ['HK chosen']); assert.equal(find('auto_test', groups[2].name).interval, 0);
  assert.deepEqual(find('select', groups[3].name).policies, ['DIRECT']); assert.deepEqual(find('select', groups[4].name).policies, ['REJECT']);
  assert.deepEqual(doc.rules.filter((entry: any) => ['alpha.example', 'beta.example'].includes(entry.domain_suffix?.match)), [{ domain_suffix: { match: 'alpha.example', policy: groups[0].name } }, { domain_suffix: { match: 'beta.example', policy: groups[0].name } }]);
  assert.ok(doc.rules.some((entry: any) => entry.ip_cidr?.match === '192.0.2.0/24')); assert.ok(doc.rules.some((entry: any) => entry.ip_cidr6?.match === '2001:db8::/32'));
  const remote = doc.rules.find((entry: any) => entry.rule_set)?.rule_set;
  assert.deepEqual(remote, { match: `${upstreamOrigin}/native-rules.yaml`, policy: groups[1].name, update_interval: 86400 });
  assert.deepEqual(yaml.load(await fetch(remote.match).then(response => response.text())), { domain_suffix_set: ['remote.example'], ip_cidr_set: ['192.0.2.0/24'] });
  assert.equal(doc.rules.find((entry: any) => entry.default)?.default.policy, groups[1].name);
  assert.ok(doc.rules.some((entry: any) => entry.domain?.match === 'kept.example'));
  const actual = await fetch(`${origin}/s/${profile.token}/egern?expand=true`); assert.equal(actual.status, 200); assert.equal(actual.headers.get('subscription-userinfo'), 'upload=1024; download=2048; total=10240; expire=1893456000'); assert.equal(await actual.text(), result.data);
  const provider = await fetch(`${origin}/s/${profile.token}/source/${source.id}?target=egern`); assert.equal(provider.status, 200); assert.equal(provider.headers.get('subscription-userinfo'), actual.headers.get('subscription-userinfo')); assert.doesNotMatch(await provider.text(), /info\.strategy\.example|剩余流量/);
});

test('unsupported native connection semantics fail consistently instead of inventing or silently dropping fields', async () => {
  const source = await addSource('/unsupported-native', [{ name: 'Plugin node', type: 'ss', server: 'unsupported.native.example', port: 443, cipher: 'aes-128-gcm', password: 'dummy', plugin: 'v2ray-plugin', 'plugin-opts': { mode: 'websocket', host: 'plugin.example' } }], []);
  const { profile } = await profileFor(source);
  const result = await preview(profile); assert.equal(result.status, 422); assert.equal(result.generation.diagnostics.at(-1).code, 'egern-node-options-unsupported');
  const actual = await fetch(`${origin}/s/${profile.token}/egern?expand=true`); assert.equal(actual.status, 422); assert.deepEqual((await actual.json() as any).generation, result.generation);
  const provider = await fetch(`${origin}/s/${profile.token}/source/${source.id}?target=egern`); assert.equal(provider.status, 422); assert.equal((await provider.json() as any).generation.diagnostics.at(-1).code, 'egern-node-options-unsupported');
  for (const node of [
    { name: 'SSR native', type: 'ssr', server: 'ssr.native.example', port: 443, cipher: 'aes-128-cfb', password: 'dummy', protocol: 'auth_sha1_v4', obfs: 'http_simple' },
    { name: 'Legacy VMess', type: 'vmess', server: 'legacy.native.example', port: 443, uuid: '11111111-1111-4111-8111-111111111111', alterId: 64, cipher: 'auto' },
    { name: 'Plain gRPC', type: 'vmess', server: 'grpc.native.example', port: 80, uuid: '11111111-1111-4111-8111-111111111111', cipher: 'auto', network: 'grpc', tls: false },
    { name: 'Unaddressed WireGuard', type: 'wireguard', server: 'wg.missing.example', port: 51820, 'private-key': 'private', 'public-key': 'peer' },
  ]) {
    const next = await addSource(`/unsupported-${node.type}-${node.port}`, [node], []); const saved = await profileFor(next);
    const rejected = await preview(saved.profile); assert.equal(rejected.status, 422); assert.match(rejected.generation.diagnostics.at(-1).code, /^egern-(node-options|protocol)-unsupported$/);
  }
});

test('retained native conditional groups keep stable references and validate every selectable branch', async () => {
  const source = await addSource('/conditional-native', [{ name: 'Conditional node', type: 'socks5', server: 'conditional.native.example', port: 1080 }], []);
  const content: any = { ...nativeTemplate, default_proxy_group: 'Native managed conditional', policy_groups: [
    ...nativeTemplate.policy_groups,
    { conditional: { name: 'Network condition', rules: [{ ssid: { match: 'Home-*', policy: 'Missing condition' } }], default_policy: 'Native managed conditional', hidden: true } },
  ] };
  const { profile, groups, template } = await profileFor(source, [{ name: 'Native managed conditional', type: 'select', sources: [source.id] }], content);
  let result = await preview(profile); assert.equal(result.status, 422); assert.equal(result.generation.diagnostics.at(-1).code, 'egern-reference-missing');
  content.policy_groups[1].conditional.rules[0].ssid.policy = 'Conditional node';
  assert.equal((await api(`/templates/${template.id}`, 'PUT', { content: yaml.dump(content) })).success, true);
  assert.equal((await api(`/nodes/${source.nodes[0].id}`, 'PUT', { name: 'Conditional local' })).success, true);
  assert.equal((await api(`/groups/${groups[0].id}`, 'PUT', { name: 'Conditional managed renamed' })).success, true);
  result = await preview(profile); assert.equal(result.success, true, result.message);
  const doc: any = yaml.load(result.data);
  assert.equal(doc.default_proxy_group, 'Conditional managed renamed');
  assert.deepEqual(doc.policy_groups.find((entry: any) => entry.conditional).conditional, { name: 'Network condition', rules: [{ ssid: { match: 'Home-*', policy: 'Conditional local' } }], default_policy: 'Conditional managed renamed', hidden: true });
  content.policy_groups[1].conditional.rules[0].ssid.policy = 'Network condition';
  await api(`/templates/${template.id}`, 'PUT', { content: yaml.dump(content) });
  result = await preview(profile); assert.equal(result.status, 422); assert.equal(result.generation.diagnostics.at(-1).code, 'egern-reference-cycle');
});

test('unsupported strategy or schema is rejected explicitly and retained template rules are not silently repaired', async () => {
  const source = await addSource('/native-invalid', [{ name: 'Native invalid candidate', type: 'socks5', server: 'invalid.native.example', port: 1080 }], []);
  const { profile, groups, template, rule } = await profileFor(source);
  const before = (await api('/groups')).data;
  const invalid = await api(`/groups/${groups[0].id}`, 'PUT', { type: 'invented-strategy' });
  assert.equal(invalid.status, 400); assert.equal(invalid.success, false);
  assert.deepEqual((await api('/groups')).data, before);
  let result = await preview(profile); assert.equal(result.success, true, result.message);
  for (const change of [{ type: 'relay' }, { type: 'urltest', lazy: true }, { type: 'load-balance', lazy: undefined, strategy: 'sticky-sessions' }]) {
    assert.equal((await api(`/groups/${groups[0].id}`, 'PUT', change)).success, true);
    result = await preview(profile); assert.equal(result.status, 422); assert.match(result.generation.diagnostics.at(-1).code, /^egern-group/);
  }
  // Create a separate supported group; old unsupported semantics stay outside this profile.
  const valid = (await api('/groups', 'POST', { name: 'Native schema valid group', type: 'select', sources: [source.id] })).data;
  await api(`/profiles/${profile.id}`, 'PUT', { selectedGroupIds: [valid.id] }); await api(`/rules/unified/${rule.id}`, 'PUT', { outbound: valid.name });
  for (const content of ['proxies: []\nproxy-groups: []\nrules: [MATCH,DIRECT]\n', 'proxies: [{name: Bad, type: ss}]\npolicy_groups: []\nrules: []\n', 'dns: {nameservers: [127.0.0.1]}\nproxies: []\npolicy_groups: []\nrules: []\n']) {
    await api(`/templates/${template.id}`, 'PUT', { content });
    result = await preview(profile); assert.equal(result.status, 422, result.message); assert.equal(result.generation.diagnostics.at(-1).code, 'egern-template-schema-unsupported');
  }
  const broken = { ...nativeTemplate, rules: [{ domain: { match: 'broken.native.example', policy: 'Missing required native policy' } }] };
  await api(`/templates/${template.id}`, 'PUT', { content: yaml.dump(broken) });
  result = await preview(profile); assert.equal(result.status, 422); assert.equal(result.generation.diagnostics.at(-1).code, 'egern-reference-missing');
  assert.equal((await api('/templates')).data.find((entry: any) => entry.id === template.id).content, yaml.dump(broken));
});

test('native prev_hop completes eligible omitted chain nodes without making them ordinary candidates or adopting DNS dependencies', async () => {
  const source = await addSource('/native-chain', [
    { name: 'Chain ordinary', type: 'socks5', server: 'ordinary.chain.example', port: 1080, 'dialer-proxy': 'Chain exit' },
    { name: 'Chain exit', type: 'socks5', server: '192.0.2.120', port: 1081 },
    { name: 'DNS unused exit', type: 'socks5', server: 'unused.chain.example', port: 1082 },
  ], ['https://chain.dns.example/query#DNS unused exit']);
  const { profile, groups } = await profileFor(source, [{ name: 'Chain candidates', type: 'select', includeAll: true }]);
  await api(`/profiles/${profile.id}`, 'PUT', { nodeFilter: { mode: 'manual', selectedNodeIds: [source.nodes[0].id] } });
  const result = await preview(profile); assert.equal(result.success, true, result.message);
  assert.equal(result.generation.nodeCount, 1); assert.equal(result.generation.dependencyNodeCount, 1);
  assert.equal(result.generation.bindings[0].status, 'unapplied');
  const doc: any = yaml.load(result.data); assertNativeReferences(doc);
  const nodes = typedValues(doc.proxies); assert.equal(nodes.find(node => node.server === 'ordinary.chain.example').prev_hop, 'Chain exit');
  assert.ok(nodes.some(node => node.name === 'Chain exit')); assert.equal(nodes.some(node => node.server === 'unused.chain.example'), false);
  assert.deepEqual(typedValues(doc.policy_groups).find(group => group.name === groups[0].name).policies, ['Chain ordinary']);
  const provider: any = yaml.load(await fetch(`${origin}/s/${profile.token}/source/${source.id}?target=egern`).then(response => response.text()));
  assert.deepEqual(typedValues(provider.proxies).map(node => node.name), ['Chain ordinary']);
  assert.equal((await api(`/nodes/${source.nodes[1].id}`, 'PUT', { name: 'Chain local exit' })).success, true);
  let renamed = await preview(profile); assert.equal(renamed.success, true, renamed.message);
  assert.equal(typedValues((yaml.load(renamed.data) as any).proxies).find(node => node.server === 'ordinary.chain.example').prev_hop, 'Chain local exit');
  await stopApp(); await startApp(); renamed = await preview(profile); assert.equal(renamed.success, true, renamed.message);
  assert.equal((await api(`/nodes/${source.nodes[1].id}`, 'PUT', { enabled: false })).success, true);
  const disabled = await preview(profile); assert.equal(disabled.status, 422); assert.equal(disabled.generation.diagnostics.at(-1).code, 'egern-reference-missing');
  assert.equal(disabled.generation.dependencyNodeCount, 0);
  const invalidProvider = await fetch(`${origin}/s/${profile.token}/source/${source.id}?target=egern`); assert.equal(invalidProvider.status, 422);
});

test('native template chains complete omitted managed groups and mounted nodes without leaking their source or candidates', async () => {
  userinfo.set('/native-required-egress', 'upload=9000; download=9000; total=99999');
  const egress = await addSource('/native-required-egress', [
    { name: 'Required native exit A', type: 'socks5', server: '192.0.2.130', port: 1080 },
    { name: 'Required native exit B', type: 'socks5', server: '192.0.2.131', port: 1081 },
  ], []);
  const required = (await api('/groups', 'POST', { name: 'Required native mount', type: 'select', sources: [egress.id] })).data;
  const ordinary = await addSource('/native-group-ordinary', [{ name: 'Group ordinary', type: 'socks5', server: 'ordinary.group.example', port: 1080 }], []);
  const content: any = { ...nativeTemplate, proxies: [{ socks5: { name: 'Template chain leaf', server: '192.0.2.132', port: 1082, prev_hop: `group:${required.id}` } }] };
  content.policy_groups = [{ select: { name: 'Template group', policies: ['Template chain leaf', 'DIRECT'] } }];
  const { profile, groups } = await profileFor(ordinary, [{ name: 'Group ordinary candidates', type: 'select', includeAll: true }], content);
  const result = await preview(profile); assert.equal(result.success, true, result.message);
  assert.equal(result.generation.nodeCount, 1); assert.equal(result.generation.dependencyNodeCount, 2);
  assert.ok(result.generation.dependencyNodes.every((entry: any) => entry.sourceId === egress.id && entry.reason.includes('Required native mount')));
  const doc: any = yaml.load(result.data); assertNativeReferences(doc);
  assert.deepEqual(typedValues(doc.policy_groups).find(group => group.name === required.name).policies, ['Required native exit A', 'Required native exit B']);
  assert.deepEqual(typedValues(doc.policy_groups).find(group => group.name === groups[0].name).policies, ['Group ordinary']);
  assert.equal(typedValues(doc.policy_groups).some(group => group.name.includes('native-required-egress')), false);
  const actual = await fetch(`${origin}/s/${profile.token}/egern?expand=true`); assert.equal(actual.status, 200); assert.equal(actual.headers.get('subscription-userinfo'), null); assert.equal(await actual.text(), result.data);
  const provider: any = yaml.load(await fetch(`${origin}/s/${profile.token}/source/${egress.id}?target=egern`).then(response => response.text())); assert.deepEqual(provider, { proxies: [] });
  await api(`/groups/${required.id}`, 'PUT', { sources: [], use: [], proxies: ['Template chain leaf'] });
  const cyclic = await preview(profile); assert.equal(cyclic.status, 422); assert.equal(cyclic.generation.diagnostics.at(-1).code, 'egern-reference-cycle');
});

test('protected Egern rule providers convert selected supported text into native sets and reject unsupported semantics', async () => {
  const source = await addSource('/rule-provider-native', [{ name: 'Rules candidate', type: 'socks5', server: 'rule.provider.example', port: 1080 }], []);
  const { profile, rule } = await profileFor(source);
  bodies.set('/classical-native.list', '# classical fixture\nDOMAIN,exact.example\nDOMAIN-SUFFIX,suffix.example\nDOMAIN-KEYWORD,keyword\nIP-CIDR,192.0.2.0/24\nIP-CIDR6,2001:db8::/32\nGEOIP,CN\n');
  const remote = (await api('/rules/unified', 'POST', { name: 'Egern text conversion', kind: 'remote', type: 'RULE-SET', payload: `${upstreamOrigin}/classical-native.list`, format: 'text', outbound: 'DIRECT', enabled: true })).data;
  await api(`/profiles/${profile.id}`, 'PUT', { selectedRuleIds: [rule.id, remote.id] });
  const result = await preview(profile); assert.equal(result.success, true, result.message);
  const doc: any = yaml.load(result.data); const url = doc.rules.find((entry: any) => entry.rule_set)?.rule_set.match;
  assert.equal(url, `${origin}/s/${profile.token}/rules/${remote.id}/egern`);
  let response = await fetch(url); assert.equal(response.status, 200);
  assert.deepEqual(yaml.load(await response.text()), { domain_set: ['exact.example'], domain_suffix_set: ['suffix.example'], domain_keyword_set: ['keyword'], ip_cidr_set: ['192.0.2.0/24'], ip_cidr6_set: ['2001:db8::/32'], geoip_set: ['CN'] });
  assert.equal((await fetch(url.replace(profile.token, 'wrong-token'))).status, 404);
  await api(`/rules/unified/${remote.id}`, 'PUT', { enabled: false }); assert.equal((await fetch(url)).status, 404);
  await api(`/rules/unified/${remote.id}`, 'PUT', { enabled: true, payload: `${upstreamOrigin}/unsupported-native.list` });
  bodies.set('/unsupported-native.list', 'PROCESS-NAME,desktop.exe\n'); response = await fetch(url); assert.equal(response.status, 502);
  await api(`/profiles/${profile.id}`, 'PUT', { selectedRuleIds: [rule.id] }); assert.equal((await fetch(url)).status, 404);
});

test('native rule providers preserve flat typed JSON and YAML payload semantics without accepting logical or per-rule resolution changes', async () => {
  const source = await addSource('/typed-rule-provider', [{ name: 'Typed rule candidate', type: 'socks5', server: 'typed.rules.example', port: 1080 }], []);
  const { profile, rule } = await profileFor(source);
  bodies.set('/typed-native.json', JSON.stringify({ version: 2, rules: [{ domain: ['exact.typed.example'], domain_suffix: ['suffix.typed.example'], domain_keyword: ['typed'], domain_regex: ['^ads\\.'] }, { ip_cidr: ['192.0.2.0/24', '2001:db8::/32'] }] }));
  const remote = (await api('/rules/unified', 'POST', { name: 'Egern typed source', kind: 'remote', type: 'RULE-SET', payload: `${upstreamOrigin}/typed-native.json`, format: 'binary', outbound: 'DIRECT', enabled: true })).data;
  await api(`/profiles/${profile.id}`, 'PUT', { selectedRuleIds: [rule.id, remote.id] });
  const result = await preview(profile); assert.equal(result.success, true, result.message);
  const url = (yaml.load(result.data) as any).rules.find((entry: any) => entry.rule_set).rule_set.match;
  let response = await fetch(url); assert.equal(response.status, 200);
  assert.deepEqual(yaml.load(await response.text()), { domain_set: ['exact.typed.example'], domain_suffix_set: ['suffix.typed.example'], domain_keyword_set: ['typed'], domain_regex_set: ['^ads\\.'], ip_cidr_set: ['192.0.2.0/24'], ip_cidr6_set: ['2001:db8::/32'] });
  bodies.set('/typed-native.yaml', 'payload: ["+.suffix.yaml.example", "exact.yaml.example", "*.wildcard.yaml.example"]\n');
  await api(`/rules/unified/${remote.id}`, 'PUT', { payload: `${upstreamOrigin}/typed-native.yaml`, format: 'yaml', behavior: 'domain' });
  response = await fetch(url); assert.equal(response.status, 200);
  assert.deepEqual(yaml.load(await response.text()), { domain_suffix_set: ['suffix.yaml.example'], domain_set: ['exact.yaml.example'], domain_wildcard_set: ['*.wildcard.yaml.example'] });
  bodies.set('/logical-native.json', JSON.stringify({ version: 3, rules: [{ type: 'logical', mode: 'and', rules: [{ domain: ['x.example'] }, { ip_cidr: ['192.0.2.0/24'] }] }] }));
  await api(`/rules/unified/${remote.id}`, 'PUT', { payload: `${upstreamOrigin}/logical-native.json`, format: 'binary' });
  assert.equal((await fetch(url)).status, 502);
  bodies.set('/noresolve-native.list', 'IP-CIDR,192.0.2.0/24,no-resolve\n');
  await api(`/rules/unified/${remote.id}`, 'PUT', { payload: `${upstreamOrigin}/noresolve-native.list`, format: 'text', behavior: 'classical' });
  assert.equal((await fetch(url)).status, 502);
});
