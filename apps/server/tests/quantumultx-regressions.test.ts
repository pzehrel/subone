import assert from 'node:assert/strict';
import test from 'node:test';
import { UnsupportedProxyGroupError } from '../src/core/generators/errors';
import {
  generateQuantumultXConfig,
  injectUnifiedToQuantumultX,
  nodeToQuantumultXProxy,
} from '../src/core/generators/quantumultx-generator';
import type { ProxyGroupItem, ProxyNode, SubscriptionSource, UnifiedRuleItem } from '../src/types/index';

const template = '[server_local]\n\n[policy]\n\n[filter_remote]\n\n[filter_local]\n';

test('AnyTLS preserves explicit certificate verification and leaves an absent option at the client default', () => {
  const node: ProxyNode = { id: 'anytls', name: 'AnyTLS', type: 'anytls', server: 'anytls.node.invalid', port: 443, password: 'fixture-password', sni: 'tls.node.invalid' };
  for (const skipCertVerify of [true, false, undefined]) {
    const output = nodeToQuantumultXProxy({ ...node, skipCertVerify });
    if (skipCertVerify === undefined) assert.doesNotMatch(output, /tls-verification=/);
    else assert.ok(output.includes(`, tls-verification=${!skipCertVerify},`), output);
    assert.match(output, /, tls-host=tls\.node\.invalid,/);
  }
});

test('VMess TCP TLS uses Quantumult X obfs fields instead of tls=true', () => {
  const node: ProxyNode = {
    id: 'vmess-tls', name: 'VMess TLS', type: 'vmess',
    server: 'vmess.node.invalid', port: 21581,
    uuid: '11111111-1111-4111-8111-111111111111', cipher: 'auto', tls: true,
  };
  for (const options of [{}, { sni: 'tls.node.invalid' }, { sni: 'tls.node.invalid', skipCertVerify: true }]) {
    const output = nodeToQuantumultXProxy({ ...node, ...options });

    assert.match(output, /, obfs=over-tls(?:,|$)/);
    assert.ok(output.includes(`, tls-verification=${!options.skipCertVerify}`));
    assert.doesNotMatch(output, /(?:^|, )(?:tls|tls-host)=/);
    if (options.sni) assert.ok(output.includes(`, obfs-host=${options.sni},`));
    else assert.doesNotMatch(output, /, obfs-host=/);
  }
});

test('Quantumult X dest-hash selects a single candidate through the documented tag regex syntax', () => {
  const node: ProxyNode = {
    id: 'tw', name: '🇨🇳 台湾W01 | IEPL | x2', type: 'ss',
    server: 'tw.invalid', port: 443, sourceId: 'upstream',
    method: 'aes-128-gcm', password: 'fixture-password',
  };
  const group: ProxyGroupItem = {
    id: 'tw', name: 'AUTO_TW', type: 'load-balance', strategy: 'consistent-hashing',
    sources: ['upstream'], filter: '台湾',
  };
  const source: SubscriptionSource = {
    id: 'upstream', name: 'Upstream', type: 'remote', enabled: true, url: 'https://upstream.invalid/sub',
  };
  const output = generateQuantumultXConfig(template, [node], [group], [], [source], { expandNodes: true });
  const policy = output.split('\n').find(line => line.startsWith('dest-hash=AUTO_TW,'));

  assert.ok(policy);
  assert.match(policy, /^dest-hash=AUTO_TW, server-tag-regex=/);
  const pattern = policy.split('server-tag-regex=')[1].split(', ')[0];
  assert.ok(new RegExp(pattern).test(node.name));
  assert.ok(!new RegExp(pattern).test('🇨🇳 台湾W02 | IEPL | x2'));
});

test('dest-hash keeps exact escaped candidates across source, filter, explicit and dependency groups', () => {
  const nodes: ProxyNode[] = [
    { id: 'one', name: 'TW [01].+ (IEPL) | x2 $^?*\\', type: 'socks5', server: 'one.invalid', port: 1080, sourceId: 'selected' },
    { id: 'two', name: 'TW=02,IEPL', type: 'socks5', server: 'two.invalid', port: 1080, sourceId: 'selected' },
    { id: 'other', name: 'TW Other', type: 'socks5', server: 'other.invalid', port: 1080, sourceId: 'other' },
    { id: 'unsupported', name: 'TW Unsupported', type: 'hysteria2', server: 'hy2.invalid', port: 443, sourceId: 'selected' },
  ];
  const sources: SubscriptionSource[] = [
    { id: 'selected', name: 'Selected', type: 'manual', enabled: true },
    { id: 'other', name: 'Other', type: 'manual', enabled: true },
  ];
  const expected = nodes.slice(0, 2).map(node => node.name.replace(/[=,]/g, '_'));
  const selections: Partial<ProxyGroupItem>[] = [
    { sources: ['selected'], filter: '^TW' },
    { filter: '^TW(?: \\[|=)' },
    { proxies: expected },
  ];
  for (const selection of selections) {
    for (const dependency of [false, true]) {
      const group: ProxyGroupItem = { id: 'hash', name: 'Hash', type: 'load-balance', strategy: 'consistent-hashing', ...selection };
      if (dependency) group.proxies = expected;
      const output = generateQuantumultXConfig(template, nodes, [group], [], sources, {
        expandNodes: true,
        dependencyGroupIds: dependency ? new Set(['hash']) : undefined,
        ordinaryNodeIds: dependency ? new Set(['other', 'unsupported']) : undefined,
      });
      const policy = output.split('\n').find(line => line.startsWith('dest-hash=Hash,'));
      assert.ok(policy, JSON.stringify({ selection, dependency }));
      const pattern = new RegExp(policy.split('server-tag-regex=')[1].split(', ')[0]);
      for (const name of expected) assert.ok(pattern.test(name), name);
      for (const name of ['TW Other', 'TW Unsupported', 'TW 01ZZ IEPL | x2', expected[0] + 'suffix', 'prefix' + expected[1]]) {
        assert.ok(!pattern.test(name), name);
      }
    }
  }
});

test('dest-hash does not silently turn builtins or child policies into server-tag matches', () => {
  for (const member of ['DIRECT', 'REJECT', 'Child', 'Native']) {
    const groups: ProxyGroupItem[] = [
      { id: 'hash', name: 'Hash', type: 'load-balance', strategy: 'consistent-hashing', sources: ['source'], proxies: [member] },
      { id: 'child', name: 'Child', type: 'select', proxies: ['DIRECT'] },
    ];
    assert.throws(() => generateQuantumultXConfig(template.replace('[policy]', '[policy]\nstatic=Native, direct'), [], groups, [], [], { expandNodes: true }), /目标哈希策略组「Hash」需要可用节点/);
  }
});

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
