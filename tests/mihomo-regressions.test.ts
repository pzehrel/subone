import assert from 'node:assert/strict';
import test from 'node:test';
import yaml from 'js-yaml';
import { generateMihomoConfig } from '../src/core/generators/mihomo-generator.js';
import type { ProxyGroupItem, ProxyNode, SubscriptionSource } from '../src/types/index.js';

interface MihomoConfig {
  proxies: Array<{ name: string; [key: string]: unknown }>;
  'proxy-groups': Array<{ name: string; type: string; proxies?: string[]; use?: string[]; filter?: string }>;
  'proxy-providers'?: Record<string, { url: string }>;
  rules: string[];
}

function node(name: string, sourceId: string, sourceName: string): ProxyNode {
  return { id: name, name, type: 'ss', server: 'node.invalid', port: 443,
    method: 'aes-128-gcm', password: 'test-password', sourceId, sourceName };
}

function source(id: string, name: string, nodes: ProxyNode[], remote = true): SubscriptionSource {
  return { id, name, type: remote ? 'remote' : 'manual', enabled: true, nodes,
    url: remote ? 'https://airport.invalid/subscription' : '' };
}

function render(nodes: ProxyNode[], groups: ProxyGroupItem[], sources: SubscriptionSource[], options = {}) {
  return yaml.load(generateMihomoConfig('proxies: []\n', nodes, groups, [], sources, options)) as MihomoConfig;
}

test('remote source filters reference providers without undefined static proxies', () => {
  const hk = node('HK-01', 'airport-a', 'AirportA');
  const output = render([hk], [
    { id: 'hk', name: 'HK', type: 'select', sources: ['AirportA'], filter: '^HK' },
  ], [source('airport-a', 'AirportA', [hk])], {
    baseUrl: 'https://sub.invalid', subToken: 'test-token',
  });

  assert.deepEqual(output.proxies, []);
  assert.equal(output['proxy-providers']?.AirportA?.url, 'https://airport.invalid/subscription');
  assert.deepEqual(output['proxy-groups'], [
    { name: 'HK', type: 'select', use: ['AirportA'], filter: '^HK' },
  ]);
});

test('a filtered remote group does not import inline nodes from an unselected source', () => {
  const remote = node('HK-remote', 'airport-a', 'AirportA');
  const unrelated = node('HK-manual', 'manual-b', 'ManualB');
  const output = render([remote, unrelated], [
    { id: 'hk', name: 'HK', type: 'select', sources: ['AirportA'], filter: '^HK' },
  ], [source('airport-a', 'AirportA', [remote]), source('manual-b', 'ManualB', [unrelated], false)]);

  assert.deepEqual(output.proxies.map(p => p.name), ['HK-manual']);
  assert.deepEqual(output['proxy-groups'], [
    { name: 'HK', type: 'select', use: ['AirportA'], filter: '^HK' },
  ]);
});

test('a filtered inline source does not subscribe to unrelated remote providers', () => {
  const remote = node('HK-remote', 'airport-a', 'AirportA');
  const local = node('HK-local', 'manual-b', 'ManualB');
  const output = render([remote, local], [
    { id: 'local', name: 'LocalHK', type: 'select', sources: ['ManualB'], filter: '^HK' },
  ], [source('airport-a', 'AirportA', [remote]), source('manual-b', 'ManualB', [local], false)]);

  assert.deepEqual(output['proxy-groups'], [
    { name: 'LocalHK', type: 'select', filter: '^HK', proxies: ['HK-local'] },
  ]);
});

test('includeAll does not override an explicitly selected manual source', () => {
  const remote = node('HK-remote', 'airport-a', 'AirportA');
  const local = node('HK-local', 'manual-b', 'ManualB');
  const output = render([remote, local], [
    { id: 'local', name: 'LocalHK', type: 'select', includeAll: true, sources: ['ManualB'], filter: '^HK' },
  ], [source('airport-a', 'AirportA', [remote]), source('manual-b', 'ManualB', [local], false)]);

  assert.deepEqual(output['proxy-groups'], [
    { name: 'LocalHK', type: 'select', filter: '^HK', proxies: ['HK-local'] },
  ]);
});

test('an expanded group with a missing or disabled source does not acquire all nodes', () => {
  const hk = node('HK-01', 'airport-a', 'AirportA');
  const disabled = { ...source('airport-a', 'AirportA', [hk]), enabled: false };
  for (const sources of [[source('airport-a', 'AirportA', [hk])], [disabled]]) {
    const requested = sources[0].enabled ? 'MissingAirport' : 'AirportA';
    const output = render([hk], [
      { id: 'hk', name: 'SelectedHK', type: 'select', includeAll: true, sources: [requested] },
    ], sources, { expandNodes: true });
    assert.deepEqual(output['proxy-groups'][0].proxies, ['REJECT']);
  }
});

test('Mihomo preserves interleaved rule order, no-resolve and the user final policy', () => {
  const output = yaml.load(generateMihomoConfig('rules:\n  - MATCH,DIRECT\n', [], [], [
    { id: 'remote', name: 'Remote', kind: 'remote', type: 'RULE-SET', payload: 'https://rules.invalid/remote.yaml', outbound: 'DIRECT', enabled: true, behavior: 'classical', noResolve: true },
    { id: 'local', name: 'Local', kind: 'local', type: 'IP-CIDR', payload: '192.0.2.0/24', outbound: 'REJECT', enabled: true, noResolve: true },
    { id: 'final', name: 'Final', kind: 'local', type: 'FINAL', payload: '', outbound: 'REJECT', enabled: true },
  ])) as MihomoConfig;

  assert.deepEqual(output.rules, [
    'RULE-SET,remote,DIRECT,no-resolve',
    'IP-CIDR,192.0.2.0/24,REJECT,no-resolve',
    'MATCH,REJECT',
  ]);
});

test('relay chains fail explicitly instead of producing a removed Mihomo group type', () => {
  const entry = node('Entry', 'manual', 'Manual');
  const exit = node('Exit', 'manual', 'Manual');

  assert.throws(() => render([entry, exit], [
    { id: 'chain', name: 'Chain', type: 'relay', proxies: ['Entry', 'Exit'] },
  ], [source('manual', 'Manual', [entry, exit], false)], { expandNodes: true }),
  { name: 'UnsupportedProxyGroupError', message: /Mihomo.*Chain/ });
});

test('invalid and dynamic relay members never fall back to a direct or select group', () => {
  for (const members of [[], ['Missing'], ['Chain'], ['Auto', 'Missing']]) {
    assert.throws(() => render([], [
      { id: 'auto', name: 'Auto', type: 'urltest', proxies: ['DIRECT'] },
      { id: 'chain', name: 'Chain', type: 'relay', proxies: members },
    ], [], { baseUrl: 'https://sub.invalid', subToken: 'test-token' }),
    { name: 'UnsupportedProxyGroupError', message: /Mihomo.*Chain/ });
  }
});

test('native dialer-proxy node configurations keep their explicit hop order', () => {
  const entry = node('Entry', 'manual', 'Manual');
  const exit = node('Exit', 'manual', 'Manual');
  exit.raw = {
    name: 'Exit', type: 'ss', server: 'exit.invalid', port: 443,
    cipher: 'aes-128-gcm', password: 'test-password', 'dialer-proxy': 'Entry',
  };
  const output = render([entry, exit], [
    { id: 'chain', name: 'Chain', type: 'select', proxies: ['Exit'] },
  ], [source('manual', 'Manual', [entry, exit], false)], { expandNodes: true });

  assert.equal(output.proxies.find(p => p.name === 'Exit')?.['dialer-proxy'], 'Entry');
  assert.deepEqual(output['proxy-groups'], [
    { name: 'Chain', type: 'select', proxies: ['Exit'] },
  ]);
});
