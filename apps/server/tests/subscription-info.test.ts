import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import yaml from 'js-yaml';
import { fetchAndParseSource } from '../src/core/parser/fetcher';
import { applySubscriptionInfo, parseSubscriptionUserinfo } from '../src/core/parser/subscription-info';
import type { ProxyNode, SubscriptionSource } from '../src/types/index';
import { formatSubscriptionTraffic, formatSubscriptionExpiry } from '../../web/src/utils/subscriptionInfo';

test('fetching separates info nodes and prefers headers, with independent traffic and expiry fallbacks', async t => {
  let header: string | undefined = 'upload=1024; download=2048; total=4096; expire=1893456000';
  let status = 200;
  const server = createServer((_request, response) => {
    response.statusCode = status;
    if (header) response.setHeader('Subscription-Userinfo', header);
    response.end(yaml.dump({ proxies: [
      { name: 'Hong Kong', type: 'ss', server: 'hk.example.test', port: 443, cipher: 'aes-128-gcm', password: 'test' },
      { name: '剩余流量：128 GB', type: 'ss', server: 'info.example.test', port: 443, cipher: 'aes-128-gcm', password: 'test' },
      { name: '套餐到期：2026-12-31', type: 'ss', server: 'info.example.test', port: 443, cipher: 'aes-128-gcm', password: 'test' },
    ] }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const source: SubscriptionSource = {
    id: 'airport', name: 'Airport', type: 'remote', enabled: true,
    url: `http://127.0.0.1:${address.port}/sub`,
    trafficNodeRegex: '剩余流量', expiryNodeRegex: '套餐到期',
  };

  source.nodes = await fetchAndParseSource(source);
  assert.deepEqual(source.nodes.map(node => node.name), ['Hong Kong']);
  assert.equal(source.infoNodes?.length, 2);
  assert.deepEqual({ ...source.subscriptionInfo }, { upload: 1024, download: 2048, total: 4096, expire: 1893456000 });
  assert.equal(formatSubscriptionTraffic(source.subscriptionInfo), '已用 3 KiB / 共 4 KiB');

  header = 'expire=0';
  source.nodes = await fetchAndParseSource(source);
  assert.equal(source.subscriptionInfo?.trafficText, '剩余流量：128 GB');
  assert.equal(source.subscriptionInfo?.remaining, 128 * 1024 ** 3);
  assert.equal(source.subscriptionInfo?.expire, 0);
  assert.equal(source.subscriptionInfo?.expiryText, undefined);
  assert.equal(formatSubscriptionExpiry(source.subscriptionInfo), '长期有效');

  header = undefined;
  source.nodes = await fetchAndParseSource(source);
  assert.equal(source.subscriptionUserinfo, undefined);
  assert.equal(source.subscriptionInfo?.expiryText, '套餐到期：2026-12-31');
  assert.equal(formatSubscriptionTraffic(source.subscriptionInfo), '剩余流量：128 GB');
  assert.equal(source.subscriptionInfo?.total, undefined);
  assert.equal(source.subscriptionInfo?.upload, undefined);
  assert.equal(source.subscriptionInfo?.download, undefined);

  const previous = structuredClone(source);
  status = 403;
  await assert.rejects(fetchAndParseSource(source), /403/);
  assert.deepEqual(source, previous);

  // Existing cached data can be reclassified after the original URL expires.
  source.trafficNodeRegex = '';
  source.expiryNodeRegex = '';
  source.nodes = applySubscriptionInfo(source, [...source.nodes, ...(source.infoNodes || [])]);
  assert.equal(source.nodes.length, 3);
  assert.deepEqual(source.infoNodes, []);
  assert.equal(source.subscriptionInfo, undefined);
});

test('malformed metadata stays unknown while zero values are preserved', () => {
  assert.deepEqual(parseSubscriptionUserinfo('upload=-1; download=NaN; total=Infinity; expire=soon'), {});
  assert.deepEqual(parseSubscriptionUserinfo('UPLOAD = 0; download=0; total=0; expire=0'), {
    upload: 0, download: 0, total: 0, expire: 0,
  });
  assert.deepEqual(parseSubscriptionUserinfo('total=999999999999999999999999'), {});
  assert.equal(formatSubscriptionTraffic({ upload: 0, download: 0, total: 0 }), '已用 0 B / 不限量');
  assert.equal(formatSubscriptionTraffic({ expire: 0 }), undefined);
});

test('unrecognized info text is retained and excluded even when numeric extraction fails', () => {
  const source: SubscriptionSource = { id: 'airport', name: 'Airport', type: 'remote', enabled: true, trafficNodeRegex: '用量', expiryNodeRegex: '期限' };
  const node: ProxyNode = { id: 'notice', name: '用量及期限请查看官网', type: 'ss', server: 'example.test', port: 443 };
  assert.deepEqual(applySubscriptionInfo(source, [node]), []);
  assert.deepEqual(source.infoNodes, [node]);
  assert.equal(source.subscriptionInfo?.trafficText, node.name);
  assert.equal(source.subscriptionInfo?.expiryText, node.name);
  assert.equal(source.subscriptionInfo?.expire, undefined);
});
