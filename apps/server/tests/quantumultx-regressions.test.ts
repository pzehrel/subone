import assert from 'node:assert/strict';
import test from 'node:test';
import { UnsupportedProxyGroupError } from '../src/core/generators/errors';
import {
  generateQuantumultXConfig,
  injectUnifiedToQuantumultX,
} from '../src/core/generators/quantumultx-generator';
import type { ProxyGroupItem, ProxyNode, SubscriptionSource, UnifiedRuleItem } from '../src/types/index';

const template = '[server_local]\n\n[policy]\n\n[filter_remote]\n\n[filter_local]\n';

test('one downstream resource keeps source-specific candidate selection without exporting source names', () => {
  const nodes: ProxyNode[] = [
    { id: 'a', name: 'HK One', type: 'ss', server: 'a.invalid', port: 443, sourceId: 'source-a' },
    { id: 'b', name: 'HK Two', type: 'ss', server: 'b.invalid', port: 443, sourceId: 'source-b' },
  ];
  const sources: SubscriptionSource[] = [
    { id: 'source-a', name: 'Upstream A', type: 'remote', enabled: true, url: 'https://a.invalid/sub' },
    { id: 'source-b', name: 'Upstream B', type: 'remote', enabled: true, url: 'https://b.invalid/sub' },
  ];
  const output = generateQuantumultXConfig(template, nodes,
    [{ id: 'selected', name: 'Selected', type: 'select', sources: ['source-a'], filter: '^HK' }], [], sources,
    { baseUrl: 'https://subone.invalid', subToken: 'token', ordinaryNodeIds: new Set(nodes.map(node => node.id)),
      nodeResource: { name: 'My subscription', url: 'https://subone.invalid/s/token/nodes/qx' } });
  assert.match(output, /^static=Selected, HK One(?:, img-url=[^\n]+)?$/m);
  assert.match(output, /^https:\/\/subone\.invalid\/s\/token\/nodes\/qx, tag=My subscription,/m);
  assert.doesNotMatch(output, /Upstream [AB]|resource-tag-regex|HK Two|\/source\//);
});

test('Quantumult X rejects Relay groups instead of returning an unusable configuration', () => {
  const relay: ProxyGroupItem = {
    id: 'relay',
    name: '出口链',
    type: 'relay',
    proxies: ['入口', '出口'],
  };

  assert.throws(
    () => generateQuantumultXConfig(template, [], [relay], [], [], { expandNodes: true }),
    error => error instanceof UnsupportedProxyGroupError && error.message.includes('出口链'),
  );
});

test('direct Quantumult X injection also rejects Relay when includeAll is enabled', () => {
  const relay: ProxyGroupItem = {
    id: 'relay-all',
    name: '自动出口链',
    type: 'relay',
    includeAll: true,
  };

  assert.throws(
    () => injectUnifiedToQuantumultX(template, [], [relay], [], [], { expandNodes: false }),
    error => error instanceof UnsupportedProxyGroupError && error.message.includes('自动出口链'),
  );
});

test('expanded Quantumult X groups respect the selected source, name filter and supported protocols', () => {
  const nodes: ProxyNode[] = [
    { id: 'a-hk', name: 'HK=A,1', type: 'ss', server: 'a.invalid', port: 443, sourceId: 'airport-a' },
    { id: 'a-sg', name: 'SG One', type: 'ss', server: 'a.invalid', port: 443, sourceId: 'airport-a' },
    { id: 'b-hk', name: 'HK Two', type: 'ss', server: 'b.invalid', port: 443, sourceId: 'airport-b' },
    { id: 'a-hy2', name: 'HK HY2', type: 'hysteria2', server: 'a.invalid', port: 443, sourceId: 'airport-a' },
  ];
  const sources: SubscriptionSource[] = [
    { id: 'airport-a', name: 'Airport A', type: 'remote', enabled: true, url: 'https://a.invalid/sub' },
    { id: 'airport-b', name: 'Airport B', type: 'remote', enabled: true, url: 'https://b.invalid/sub' },
  ];
  const groups: ProxyGroupItem[] = [{
    id: 'hk',
    name: '香港优选',
    type: 'select',
    includeAll: true,
    sources: ['AIRPORT-A'],
    filter: '(?i)^hk',
  }];

  const output = generateQuantumultXConfig(template, nodes, groups, [], sources, { expandNodes: true });

  assert.match(output, /^static=香港优选, HK_A_1(?:, img-url=[^\n]+)?$/m);
  assert.doesNotMatch(output, /https:\/\/[ab]\.invalid\/sub/);
});

test('includeAll keeps explicit direct choices and child policies in both output modes', () => {
  const nodes: ProxyNode[] = [{ id: 'hk', name: 'HK-01', type: 'ss', server: 'node.invalid', port: 443, sourceId: 'airport-a' }];
  const sources: SubscriptionSource[] = [{ id: 'airport-a', name: 'Airport A', type: 'remote', enabled: true, url: 'https://airport.invalid/sub', nodes }];
  const groups: ProxyGroupItem[] = [
    { id: 'mixed', name: 'Mixed', type: 'select', includeAll: true, sources: ['airport-a'], proxies: ['DIRECT', 'Auto', 'DIRECT', 'Missing'] },
    { id: 'auto', name: 'Auto', type: 'select', proxies: ['DIRECT'] },
  ];
  for (const expandNodes of [false, true]) {
    const output = generateQuantumultXConfig(template, nodes, groups, [], sources, { expandNodes });
    const line = output.split('\n').find(line => line.startsWith('static=Mixed,'));
    assert.ok(line);
    assert.match(line, /^static=Mixed, direct, Auto, /);
    assert.equal(line.match(/\bdirect\b/g)?.length, 1);
    assert.doesNotMatch(line, /Missing/);
  }
});

test('remote Quantumult X groups combine the selected resource and node-name filters', () => {
  const sources: SubscriptionSource[] = [
    { id: 'airport-a', name: 'Airport A.+[1]', type: 'remote', enabled: true, url: 'https://a.invalid/sub' },
    { id: 'airport-b', name: 'Airport B', type: 'remote', enabled: true, url: 'https://b.invalid/sub' },
  ];
  const groups: ProxyGroupItem[] = [{
    id: 'selected', name: 'Selected', type: 'select', includeAll: true,
    sources: ['airport-a'], filter: '(?i)^hk',
  }];

  const output = generateQuantumultXConfig(template, [], groups, [], sources);
  const policy = output.split('\n').find(line => line.startsWith('static=Selected,'));

  assert.equal(
    policy?.split(', img-url=')[0],
    'static=Selected, resource-tag-regex=^(?:Airport A\\.\\+\\[1\\])$, server-tag-regex=(?i)^hk',
  );
});

test('manual Quantumult X groups list only matching nodes from the selected source', () => {
  const nodes: ProxyNode[] = [
    { id: 'local-hk', name: 'HK Local', type: 'ss', server: 'local.invalid', port: 443, sourceId: 'local-a' },
    { id: 'local-sg', name: 'SG Local', type: 'ss', server: 'local.invalid', port: 443, sourceId: 'local-a' },
    { id: 'other-hk', name: 'HK Other', type: 'ss', server: 'other.invalid', port: 443, sourceId: 'local-b' },
  ];
  const sources: SubscriptionSource[] = [
    { id: 'local-a', name: 'Local A', type: 'manual', enabled: true },
    { id: 'local-b', name: 'Local B', type: 'manual', enabled: true },
  ];
  const groups: ProxyGroupItem[] = [{
    id: 'selected', name: 'Selected', type: 'select', includeAll: true,
    sources: ['local-a'], filter: '(?i)^hk',
  }];

  const output = generateQuantumultXConfig(template, nodes, groups, [], sources);
  const policy = output.split('\n').find(line => line.startsWith('static=Selected,'));

  assert.equal(policy?.split(', img-url=')[0], 'static=Selected, HK Local');
});

test('mixed Quantumult X groups combine chosen inline nodes with chosen remote resources', () => {
  const nodes: ProxyNode[] = [
    { id: 'local-hk', name: 'HK Local', type: 'ss', server: 'local.invalid', port: 443, sourceId: 'local' },
    { id: 'local-sg', name: 'SG Local', type: 'ss', server: 'local.invalid', port: 443, sourceId: 'local' },
    { id: 'remote-hk', name: 'HK Remote', type: 'ss', server: 'a.invalid', port: 443, sourceId: 'airport-a' },
    { id: 'other-hk', name: 'HK Other', type: 'ss', server: 'b.invalid', port: 443, sourceId: 'airport-b' },
  ];
  const sources: SubscriptionSource[] = [
    { id: 'local', name: 'Local', type: 'manual', enabled: true },
    { id: 'airport-a', name: 'Airport A', type: 'remote', enabled: true, url: 'https://a.invalid/sub' },
    { id: 'airport-b', name: 'Airport B', type: 'remote', enabled: true, url: 'https://b.invalid/sub' },
  ];
  const groups: ProxyGroupItem[] = [{
    id: 'selected', name: 'Selected', type: 'select', includeAll: true,
    use: ['Local', 'Airport A'], filter: '(?i)^hk',
  }];

  const output = generateQuantumultXConfig(template, nodes, groups, [], sources);
  const policy = output.split('\n').find(line => line.startsWith('static=Selected,'));

  assert.equal(
    policy?.split(', img-url=')[0],
    'static=Selected, HK Local, resource-tag-regex=^(?:Airport A)$, server-tag-regex=(?i)^hk',
  );
});

test('Quantumult X refuses ambiguous resource tags rather than including an unselected subscription', () => {
  const sources: SubscriptionSource[] = [
    { id: 'airport-a', name: 'Same,Tag', type: 'remote', enabled: true, url: 'https://a.invalid/sub' },
    { id: 'airport-b', name: 'Same=Tag', type: 'remote', enabled: true, url: 'https://b.invalid/sub' },
  ];
  const groups: ProxyGroupItem[] = [{
    id: 'selected', name: 'Selected', type: 'select', includeAll: true, sources: ['airport-a'],
  }];

  assert.throws(
    () => generateQuantumultXConfig(template, [], groups, [], sources),
    /Quantumult X 无法区分策略组「Selected」的订阅来源.*名称冲突/,
  );
});

test('classical rules use the protected Quantumult X conversion link', () => {
  const rules: UnifiedRuleItem[] = [{
    id: 'office/team',
    name: 'Office rules',
    kind: 'remote',
    type: 'RULE-SET',
    payload: 'https://rules.invalid/corp.yaml',
    format: 'yaml',
    behavior: 'classical',
    outbound: 'DIRECT',
    enabled: true,
  }];

  const output = injectUnifiedToQuantumultX(template, [], [], rules, [], {
    baseUrl: 'https://subone.invalid',
    subToken: 'profile token',
  });

  assert.match(output, /^https:\/\/subone\.invalid\/s\/profile%20token\/rules\/office%2Fteam\/qx, tag=corp, force-policy=direct,/m);
  assert.doesNotMatch(output, /https:\/\/rules\.invalid\/corp\.yaml/);
});

test('Quantumult X keeps no-resolve and the selected final policy without duplicating the template final', () => {
  const rules: UnifiedRuleItem[] = [
    {
      id: 'ipv6', name: 'IPv6 direct', kind: 'local', type: 'IP-CIDR',
      payload: '2001:db8::/32', outbound: 'DIRECT', noResolve: true, enabled: true,
    },
    {
      id: 'final', name: 'Fallback', kind: 'local', type: 'FINAL',
      payload: '', outbound: 'REJECT', enabled: true,
    },
  ];

  const output = generateQuantumultXConfig(`${template}final, direct\n`, [], [], rules);

  assert.match(output, /^ip6-cidr, 2001:db8::\/32, direct, no-resolve$/m);
  assert.deepEqual(output.match(/^final, .+$/gm), ['final, reject']);
});
