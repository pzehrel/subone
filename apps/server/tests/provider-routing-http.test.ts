import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
const upstream = createServer((request, response) => response.end(bodies.get(request.url || '/') || 'proxies: []'));
const targets = ['singbox', 'mihomo', 'loon', 'quantumultx', 'egern', 'shadowrocket'];

async function api(path: string, method = 'GET', value?: unknown) {
  const response = await fetch(`${origin}/api${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: value === undefined ? undefined : JSON.stringify(value) });
  return { status: response.status, ...await response.json() as any };
}
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'subone-provider-routing-http-'));
  await writeFile(join(directory, 'config.json'), JSON.stringify({ port: 3456, adminPassword: '' }));
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const address = upstream.address(); assert.ok(address && typeof address !== 'string');
  upstreamOrigin = `http://127.0.0.1:${address.port}`;
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

async function source(path: string, outbounds: any[]) {
  bodies.set(path, JSON.stringify({ outbounds }));
  const result = await api('/sources', 'POST', { name: path.slice(1), url: upstreamOrigin + path });
  assert.equal(result.success, true, result.message); assert.equal(result.data.nodes.length, outbounds.length);
  return result.data;
}
function ss(name: string, server: string, extra = {}) {
  return { type: 'shadowsocks', tag: name, server, server_port: 443, method: 'aes-128-gcm', password: 'dummy', ...extra };
}
function nativeTemplate(target: string, brokenGroup: string): string {
  if (target === 'singbox') return JSON.stringify({
    dns: { servers: [{ type: 'udp', tag: 'Unused template resolver', server: '192.0.2.53' }] },
    outbounds: [{ type: 'direct', tag: 'DIRECT' }],
    route: { rules: [{ domain: ['unused.provider.example'], outbound: brokenGroup }], final: 'Missing native FINAL' },
  });
  if (target === 'mihomo') return yaml.dump({
    dns: { enable: true, nameserver: ['192.0.2.53'] }, proxies: [], 'proxy-groups': [],
    rules: [`DOMAIN,unused.provider.example,${brokenGroup}`, 'MATCH,Missing native FINAL'],
  });
  if (target === 'egern') return yaml.dump({
    dns: { bootstrap: ['192.0.2.53'] }, proxies: [], policy_groups: [],
    rules: [{ domain: { match: 'unused.provider.example', policy: brokenGroup } }, { default: { policy: 'Missing native FINAL' } }],
  });
  if (target === 'quantumultx') return `[general]\n[dns]\nserver=192.0.2.53\n[server_local]\n[policy]\n[filter_local]\nhost,unused.provider.example,${brokenGroup}\nfinal,Missing native FINAL\n`;
  return `[General]\ndns-server = 192.0.2.53\n[Proxy]\n[Proxy Group]\n[Rule]\nDOMAIN,unused.provider.example,${brokenGroup}\nFINAL,Missing native FINAL\n`;
}
async function profileFor(target: string, templateContent: string, nodeIds: string[], groupIds: string[]) {
  const template = await api('/templates', 'POST', { name: `${target} provider boundary`, type: target, content: templateContent });
  assert.equal(template.success, true, template.message);
  const profile = await api('/profiles', 'POST', { name: `${target} provider boundary`, nodeFilter: { mode: 'manual', selectedNodeIds: nodeIds }, selectedGroupIds: groupIds, templates: { [target]: template.data.id } });
  assert.equal(profile.success, true, profile.message);
  return profile.data;
}
function providerText(target: string, output: string): string {
  return ['singbox', 'shadowrocket'].includes(target) ? Buffer.from(output, 'base64').toString() : output;
}

test('source outputs ignore unused managed groups, template rules and FINAL while full configurations still require repair', async t => {
  const ordinary = await source('/provider-ordinary', [ss('Provider ordinary', '192.0.2.10'), ss('Provider excluded', '192.0.2.11'), ss('Provider disabled', '192.0.2.12')]);
  const excluded = await source('/provider-excluded-source', [ss('Excluded source node', '192.0.2.13')]);
  assert.equal((await api(`/nodes/${ordinary.nodes[2].id}`, 'PUT', { enabled: false })).success, true);
  const safe = await api('/groups', 'POST', { name: 'Provider Safe', type: 'select', proxies: ['DIRECT'] });
  assert.equal(safe.success, true, safe.message);
  const unused = await api('/groups', 'POST', { name: 'Unused broken provider group', type: 'select', proxies: [`node:${ordinary.nodes[2].id}`], sources: [excluded.id] });
  assert.equal(unused.success, true, unused.message);

  for (const target of targets) await t.test(target, async () => {
    const profile = await profileFor(target, nativeTemplate(target, unused.data.name), [ordinary.nodes[0].id], [safe.data.id]);
    const preview = await api('/generate/preview', 'POST', { profileId: profile.id, customType: target, expandNodes: true });
    assert.equal(preview.status, 422, JSON.stringify(preview));
    assert.equal(preview.generation.nodeCount, 1);
    assert.equal(preview.generation.dependencyNodeCount, 0);
    assert.ok(preview.generation.diagnostics.some((entry: any) => entry.severity === 'error'));
    const complete = await fetch(`${origin}/s/${profile.token}/${target}?expand=true`);
    assert.equal(complete.status, 422, target);

    for (const selectedGroupIds of [[safe.data.id], [safe.data.id, unused.data.id]]) {
      assert.equal((await api(`/profiles/${profile.id}`, 'PUT', { selectedGroupIds })).success, true);
      const provider = await fetch(`${origin}/s/${profile.token}/source/${ordinary.id}/${target}`);
      const output = await provider.text();
      assert.equal(provider.status, 200, `${target}: ${output}`);
      assert.equal(provider.headers.get('X-SubOne-Mode'), 'nodes');
      const text = providerText(target, output);
      assert.match(text, /192\.0\.2\.10/);
      assert.doesNotMatch(text, /192\.0\.2\.(?:11|12|13|53)\b|Provider Safe|Unused broken provider group|Missing native FINAL|unused\.provider\.example/);
      assert.doesNotMatch(text, /\[DNS\]|\[dns\]|\[Rule\]|\[filter_local\]|policy_groups|proxy-groups|(?:group|node|unresolved|ambiguous):/);
      const excludedProvider = await fetch(`${origin}/s/${profile.token}/source/${excluded.id}/${target}`);
      assert.equal(excludedProvider.status, 200, `${target}: excluded source`);
      assert.doesNotMatch(providerText(target, await excludedProvider.text()), /192\.0\.2\./);
    }
  });
});

test('source providers still validate actual node chains after unused routing roots are removed', async t => {
  const chained = await source('/provider-chain', [
    ss('Provider chain ordinary', '192.0.2.20', { detour: 'Provider chain exit' }),
    ss('Provider chain exit', '192.0.2.21'),
  ]);
  const safe = await api('/groups', 'POST', { name: 'Provider chain Safe', type: 'select', proxies: ['DIRECT'] });
  assert.equal(safe.success, true, safe.message);
  const profiles = new Map<string, any>();
  for (const target of ['mihomo', 'egern', 'loon', 'quantumultx']) profiles.set(target,
    await profileFor(target, nativeTemplate(target, 'Unused chain routing root'), [chained.nodes[0].id], [safe.data.id]));

  for (const target of ['mihomo', 'egern']) await t.test(`${target} supported chain`, async () => {
    const profile = profiles.get(target);
    const provider = await fetch(`${origin}/s/${profile.token}/source/${chained.id}/${target}`);
    const output = await provider.text();
    assert.equal(provider.status, 200, output);
    const document = yaml.load(output) as any;
    const proxy = target === 'mihomo' ? document.proxies[0] : Object.values(document.proxies[0])[0] as any;
    assert.equal(proxy.server, '192.0.2.20');
    assert.equal(proxy[target === 'mihomo' ? 'dialer-proxy' : 'prev_hop'], 'Provider chain exit');
    assert.equal(document.proxies.length, 1, 'dependency-only exits remain outside ordinary source providers');
    assert.doesNotMatch(output, /192\.0\.2\.(?:21|53)\b|Unused chain routing root|Missing native FINAL|unused\.provider\.example/);
  });
  for (const target of ['loon', 'quantumultx']) await t.test(`${target} unsupported chain`, async () => {
    const provider = await fetch(`${origin}/s/${profiles.get(target).token}/source/${chained.id}/${target}`);
    assert.equal(provider.status, 422);
    const failure = await provider.json() as any;
    assert.ok(failure.generation.diagnostics.some((entry: any) => entry.severity === 'error' && entry.code === (target === 'loon' ? 'loon-node-route-unapplied' : 'quantumultx-node-chain-unverified')));
  });

  assert.equal((await api(`/nodes/${chained.nodes[1].id}`, 'PUT', { enabled: false })).success, true);
  for (const target of ['mihomo', 'egern']) await t.test(`${target} disabled chain exit`, async () => {
    const provider = await fetch(`${origin}/s/${profiles.get(target).token}/source/${chained.id}/${target}`);
    assert.equal(provider.status, 422);
    const failure = await provider.json() as any;
    assert.ok(failure.generation.diagnostics.some((entry: any) => entry.severity === 'error' && entry.code === (target === 'egern' ? 'egern-reference-missing' : 'source-doh-dependency-missing')));
  });
});
