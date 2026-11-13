import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { ClientType, SubscriptionSource } from '../src/types';
import type { GenerationPlan } from '../src/services/generation/types';
import { resolveNodeDns } from '../src/services/generation/node-domain-ranges';

let render: typeof import('../src/services/generation')['renderGeneration'];
let directory: string;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'subone-domain-doh-'));
  process.env.SUBONE_ROOT = directory;
  render = (await import('../src/services/generation')).renderGeneration;
});
after(async () => { await rm(directory, { recursive: true, force: true }); });

const templates: Record<ClientType, string> = {
  quantumultx: '[dns]\nserver=192.0.2.53\n[server_local]\n[policy]\n[filter_local]\nfinal,direct\n',
  shadowrocket: '[General]\ndns-server=192.0.2.53\n[Host]\n[Proxy]\n[Proxy Group]\n[Rule]\nFINAL,DIRECT\n',
  loon: '[General]\ndns-server=192.0.2.53\n[Host]\n[Proxy]\n[Proxy Group]\n[Rule]\nFINAL,DIRECT\n',
  mihomo: 'dns:\n  enable: true\n  default-nameserver: [192.0.2.53]\n  nameserver: [192.0.2.53]\n  proxy-server-nameserver: [192.0.2.53]\nproxies: []\nproxy-groups: []\nrules: [MATCH,DIRECT]\n',
  egern: 'dns:\n  bootstrap: [192.0.2.53]\nproxies: []\npolicy_groups: []\nrules:\n  - default:\n      policy: DIRECT\n',
  singbox: JSON.stringify({ dns: { servers: [{ type: 'udp', tag: 'bootstrap', server: '192.0.2.53' }], final: 'bootstrap' }, route: { default_domain_resolver: { server: 'bootstrap' } }, outbounds: [{ type: 'direct', tag: 'DIRECT' }] }),
};
export function makeSource(id: string, hosts: string[], urls: string[]): SubscriptionSource {
  return { id, name: id, enabled: true, type: 'remote', url: 'https://upstream.example/sub',
    nodes: hosts.map((server, i) => ({ id: `${id}-${i}`, name: `${id}-${i}`, type: 'socks5', server, port: 1080, enabled: true, sourceId: id })),
    doh: { sourceId: id, batchId: 'batch', updatedAt: '2026-11-07T00:00:00Z', format: 'quantumultx', outbounds: [], services: urls.map((url, i) => ({ id: `${id}-dns-${i}`, url, path: `dns.line[1].doh-server[${i}]`, raw: { line: `doh-server=${url}`, value: url, options: [] } })) },
  };
}
export function makePlan(target: ClientType, sources: SubscriptionSource[]): GenerationPlan {
  const nodes = sources.flatMap(source => source.nodes || []);
  return { target: { type: target, mode: 'complete' }, templateContent: templates[target],
    inventory: { sources, nodes: nodes.map(node => ({ node, sourceId: node.sourceId!, state: 'enabled' })), groups: [] },
    ordinaryNodes: nodes, dependencyNodes: [], dependencyGroupIds: [], ordinaryGroupIds: [], groups: [], rules: [], sources,
    bindings: sources.map(source => ({ sourceId: source.id, sourceName: source.name, nodeIds: (source.nodes || []).map(node => node.id), services: source.doh?.services || [], status: 'template', method: 'template-dns', appliedServiceIds: [], diagnostics: [] })),
    expandNodes: true, baseUrl: 'https://subone.example', subToken: 'test-token',
  };
}

test('Quantumult X emits every scoped DoH on its own line in upstream order', () => {
  const urls = ['https://192.0.2.10/dns-query', 'https://192.0.2.11/dns-query', 'https://192.0.2.12/dns-query'];
  const source = makeSource('airport', ['one.airport.example', 'two.airport.example'], urls);
  const result = render(makePlan('quantumultx', [source]));
  assert.deepEqual(result.output.split('\n').filter(line => line.startsWith('doh-server')),
    urls.map(url => `doh-server = /*.airport.example/${url}`));
  assert.match(result.output, /^#.*Quantumult X 1\.8\.0.*首条/m);
  const binding = result.generation.bindings[0];
  assert.equal(binding.status, 'applied');
  assert.deepEqual(binding.appliedServiceIds, source.doh!.services.map(service => service.id));
  assert.deepEqual(binding.effectiveServices?.map(service => service.url), urls);
  assert.deepEqual(binding.diagnostics, []);
  assert.match(result.output, /^server=192\.0\.2\.53$/m);
  assert.equal(source.doh!.services.length, 3, 'saved source intent retains every service');
});

const urls = ['https://192.0.2.10/dns-query', 'https://192.0.2.11/dns-query', 'https://192.0.2.12/dns-query'];
for (const target of Object.keys(templates) as ClientType[]) test(`${target}: same-domain sources deduplicate DoH and share them with a source without DoH`, () => {
  const sources = [makeSource('a', ['one.airport.example', 'two.airport.example'], urls), makeSource('b', ['one.airport.example'], urls), makeSource('c', ['one.airport.example'], [])];
  const plan = makePlan(target, sources);
  const snapshot = JSON.stringify(plan);
  const result = render(plan);
  assert.ok(result.output.includes(urls[0].replace('https://', '').split('/')[0]), result.output);
  const firstOnly = target === 'singbox';
  if (!firstOnly) for (const url of urls) assert.ok(result.output.includes(url), url);
  for (const binding of result.generation.bindings) {
    assert.equal(binding.status, firstOnly ? 'degraded' : 'applied', JSON.stringify(binding));
    assert.deepEqual(binding.domainRanges, ['*.airport.example']);
    assert.equal(binding.effectiveServices?.length, firstOnly ? 1 : 3);
  }
  assert.equal(result.generation.bindings[2].services.length, 0, 'borrowed DoH must not rewrite source intent');
  assert.equal(JSON.stringify(plan), snapshot, 'render must not mutate the saved/input plan');
  if (target === 'shadowrocket') assert.match(result.output, /\*\.airport\.example = server:https:\/\/192\.0\.2\.10\/dns-query,https:\/\/192\.0\.2\.11\/dns-query,https:\/\/192\.0\.2\.12\/dns-query/);
  if (target === 'quantumultx') assert.deepEqual(result.output.split('\n').filter(line => line.startsWith('doh-server')),
    urls.map(url => `doh-server = /*.airport.example/${url}`));
});

test('Quantumult X preserves source precedence while deduplicating a shared domain DoH list', () => {
  const a = makeSource('a', ['shared.airport.example'], [urls[2], urls[0]]);
  const b = makeSource('b', ['shared.airport.example'], [urls[1], urls[2]]);
  for (const [sources, expected] of [[[a, b], [urls[2], urls[0], urls[1]]], [[b, a], [urls[1], urls[2], urls[0]]]] as const) {
    const plan = makePlan('quantumultx', [...sources]);
    const snapshot = JSON.stringify(plan);
    const result = render(plan);
    assert.deepEqual(result.output.split('\n').filter(line => line.startsWith('doh-server')),
      expected.map(url => `doh-server = /shared.airport.example/${url}`));
    assert.ok(result.generation.bindings.every(binding => binding.status === 'applied'));
    assert.equal(JSON.stringify(plan), snapshot);
  }
});

test('different same-domain DoH sets are merged rather than treated as a conflict', () => {
  const sources = [makeSource('a', ['one.airport.example'], [urls[0]]), makeSource('b', ['one.airport.example'], [urls[1]])];
  const resolved = resolveNodeDns(makePlan('mihomo', sources));
  assert.deepEqual(resolved.ranges[0].services.map(entry => entry.service.url), urls.slice(0, 2));
  const result = render(makePlan('mihomo', sources));
  assert.ok(result.output.includes(urls[0]) && result.output.includes(urls[1]));
  assert.ok(result.generation.bindings.every(binding => binding.status === 'applied'));
});

for (const target of ['mihomo', 'shadowrocket', 'egern', 'loon', 'quantumultx'] as ClientType[]) test(`${target}: adoption in one range does not mark a skipped shared range as applied`, () => {
  const sources = [makeSource('a', ['own.airport.example', 'shared.airport.example'], [urls[0]]), makeSource('b', ['shared.airport.example'], [urls[1]])];
  sources[1].doh!.format = 'singbox';
  sources[1].doh!.services[0].raw = { type: 'https', server: '192.0.2.11', path: '/dns-query', headers: { 'X-Source': 'b' } };
  sources[1].doh!.services[0].outbound = { kind: 'direct' };
  const result = render(makePlan(target, sources));
  assert.equal(result.generation.bindings[0].status, 'degraded');
  assert.deepEqual(result.generation.bindings[0].domainRanges, ['own.airport.example']);
  assert.equal(result.generation.bindings[1].status, 'unapplied');
  assert.deepEqual(result.generation.bindings[1].domainRanges, []);
  assert.deepEqual(result.generation.bindings[1].effectiveServices, []);
});

test('singbox reports first-only per range even when both services are used by other nodes', () => {
  const sources = [makeSource('a', ['a.airport.example', 'shared.airport.example'], [urls[0]]), makeSource('b', ['b.airport.example', 'shared.airport.example'], [urls[1]])];
  const result = render(makePlan('singbox', sources));
  assert.ok(result.generation.bindings.every(binding => binding.status === 'degraded'));
  assert.ok(result.generation.bindings.every(binding => binding.diagnostics.some(entry => entry.code === 'source-doh-first-only')));
});

test('Quantumult X retains template DNS when a later DoH cannot be fully converted', () => {
  const source = makeSource('a', ['one.airport.example', 'two.airport.example'], urls.slice(0, 2));
  source.doh!.services[1].raw = { options: ['unsupported-option'] };
  const result = render(makePlan('quantumultx', [source]));
  const binding = result.generation.bindings[0];
  assert.doesNotMatch(result.output, /doh-server|仅使用首条/);
  assert.match(result.output, /^server=192\.0\.2\.53$/m);
  assert.equal(binding.status, 'unapplied');
  assert.deepEqual(binding.appliedServiceIds, []);
  assert.deepEqual(binding.effectiveServices, []);
  assert.deepEqual(binding.diagnostics.map(entry => entry.code), ['source-doh-options-unapplied']);
  assert.equal(binding.diagnostics[0].serviceId, source.doh!.services[1].id);
});

test('Quantumult X does not substitute a later DoH when the first service cannot be converted', () => {
  const source = makeSource('a', ['one.airport.example', 'two.airport.example'], urls.slice(0, 2));
  source.doh!.services[0].raw = { options: ['unsupported-option'] };
  const result = render(makePlan('quantumultx', [source]));
  const binding = result.generation.bindings[0];
  assert.doesNotMatch(result.output, /doh-server/);
  assert.match(result.output, /^server=192\.0\.2\.53$/m);
  assert.equal(binding.status, 'unapplied');
  assert.deepEqual(binding.appliedServiceIds, []);
  assert.ok(binding.diagnostics.some(entry => entry.code === 'source-doh-options-unapplied'));
});

test('Quantumult X records an unapplied shared range separately from an adopted private range', () => {
  const a = makeSource('a', ['own.airport.example', 'shared.airport.example'], [urls[0]]);
  const b = makeSource('b', ['shared.airport.example'], [urls[1]]);
  b.doh!.services[0].raw = { options: ['unsupported-option'] };
  const result = render(makePlan('quantumultx', [b, a]));
  const own = result.generation.bindings.find(binding => binding.sourceId === a.id)!;
  const shared = result.generation.bindings.find(binding => binding.sourceId === b.id)!;
  assert.equal(own.status, 'degraded');
  assert.deepEqual(own.domainRanges, ['own.airport.example']);
  assert.ok(!own.diagnostics.some(entry => entry.code === 'source-doh-first-only'));
  assert.equal(shared.status, 'unapplied');
  assert.deepEqual(shared.domainRanges, []);
  assert.deepEqual(shared.effectiveServices, []);
});

test('range inference respects public/private suffixes and known competing resolution intents', () => {
  for (const hosts of [['a.co.uk', 'b.co.uk'], ['a.github.io', 'b.github.io']]) {
    const ranges = resolveNodeDns(makePlan('quantumultx', [makeSource('a', hosts, urls)])).ranges;
    assert.equal(ranges.length, 2); assert.ok(ranges.every(range => !range.wildcard));
  }
  const mixed = [makeSource('a', ['a.zone.example', 'b.zone.example'], urls), makeSource('b', ['c.zone.example'], [urls[1]])];
  assert.ok(resolveNodeDns(makePlan('quantumultx', mixed)).ranges.every(range => !range.wildcard));
  const endpoint = makeSource('a', ['a.zone.example', 'b.zone.example'], ['https://dns.zone.example/dns-query']);
  assert.ok(resolveNodeDns(makePlan('quantumultx', [endpoint])).ranges.every(range => !range.wildcard));
});

test('aliases participate in automatic grouping; IP nodes never become DNS patterns', () => {
  const source = makeSource('a', ['one.zone.example', '192.0.2.2', '2001:db8::1'], urls);
  const raw = '[dns]\nalias=/one.zone.example/two.zone.example\n';
  for (const encoding of [undefined, 'base64'] as const) {
    source.rawSubscription = { content: encoding ? Buffer.from(raw).toString('base64') : raw, ...(encoding ? { encoding } : {}), fetchedAt: '2026-11-07T00:00:00Z', format: 'quantumultx', parseStatus: 'success' };
    const ranges = resolveNodeDns(makePlan('quantumultx', [source])).ranges;
    assert.equal(ranges.length, 1); assert.equal(ranges[0].wildcard, true); assert.equal(ranges[0].domain, 'zone.example');
    assert.equal(ranges[0].nodeIds.length, 1);
  }
});

test('different connection parameters are not deduplicated merely because the URL is equal', () => {
  const sources = [makeSource('a', ['shared.zone.example'], [urls[0]]), makeSource('b', ['shared.zone.example'], [urls[0]])];
  for (const source of sources) {
    source.doh!.format = 'singbox';
    source.doh!.services[0].raw = { type: 'https', server: '192.0.2.10', headers: { 'X-Source': source.id } };
    source.doh!.services[0].outbound = { kind: 'direct' };
  }
  assert.equal(resolveNodeDns(makePlan('singbox', sources)).ranges[0].services.length, 2);
});

test('generated Mihomo wildcard policies participate in concrete DNS cycle validation', () => {
  const source = makeSource('a', ['one.zone.example', 'two.zone.example'], [urls[0]]);
  source.doh!.format = 'mihomo';
  source.doh!.services[0].raw = `${urls[0]}#a-0`;
  source.doh!.services[0].outbound = { kind: 'source-node', name: 'a-0', nodeId: 'a-0' };
  assert.throws(() => render(makePlan('mihomo', [source])), (error: any) => error.generation?.diagnostics.some((entry: any) => entry.code === 'source-doh-cycle'));
});

test('Egern refuses a template override which would bypass the generated domain rules', () => {
  const plan = makePlan('egern', [makeSource('a', ['one.zone.example', 'two.zone.example'], urls)]);
  plan.templateContent = plan.templateContent.replace('  bootstrap:', '  proxy_nameservers: [https://192.0.2.99/dns-query]\n  bootstrap:');
  assert.throws(() => render(plan), (error: any) => error.generation?.diagnostics.some((entry: any) => entry.code === 'egern-proxy-dns-override'));
});

test('a domain alias inherits the final DoH set borrowed from another source', () => {
  const sources = [makeSource('a', ['one.zone.example'], []), makeSource('b', ['one.zone.example'], urls)];
  sources[0].doh!.domainAliases = { 'one.zone.example': 'two.zone.example' };
  const range = resolveNodeDns(makePlan('quantumultx', sources)).ranges[0];
  assert.equal(range.domain, 'zone.example'); assert.equal(range.wildcard, true);
  assert.equal(range.nodeIds.length, 2); assert.equal(range.services.length, 3);
});

test('reachable alias cycles and contradictory targets cannot be silently emitted', () => {
  const source = makeSource('a', ['one.zone.example'], urls);
  source.doh!.domainAliases = { 'one.zone.example': 'two.zone.example', 'two.zone.example': 'one.zone.example' };
  assert.throws(() => resolveNodeDns(makePlan('quantumultx', [source]), true), (error: any) => error.generation?.diagnostics.some((entry: any) => entry.code === 'source-doh-cycle'));
  source.doh!.domainAliases = { 'one.zone.example': 'two.zone.example' };
  const other = makeSource('b', ['one.zone.example'], urls);
  other.doh!.domainAliases = { 'one.zone.example': 'three.zone.example' };
  assert.throws(() => resolveNodeDns(makePlan('quantumultx', [source, other]), true), (error: any) => error.generation?.diagnostics.some((entry: any) => entry.code === 'source-doh-alias-conflict'));
});

test('a broader template Host override cannot silently bypass a source DNS range', () => {
  for (const target of ['egern', 'loon', 'shadowrocket', 'quantumultx'] as ClientType[]) {
    const plan = makePlan(target, [makeSource('a', ['one.zone.example', 'two.zone.example'], urls)]);
    plan.templateContent = target === 'egern'
      ? plan.templateContent.replace('  bootstrap:', '  hosts: {"*.example": 192.0.2.99}\n  bootstrap:')
      : target === 'quantumultx'
        ? plan.templateContent.replace('[dns]', '[dns]\naddress=/*.example/192.0.2.99')
        : plan.templateContent.replace('[Host]', '[Host]\n*.example = 192.0.2.99');
    assert.throws(() => render(plan), (error: any) => error.generation?.diagnostics.some((entry: any) => entry.code === 'source-doh-host-override'), target);
  }
});
