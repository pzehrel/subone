import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aggregateSubscriptionInfo, selectSubscriptionSources } from '../../../shared/subscription-info';
import { formatSubscriptionUserinfo } from '../src/core/parser/subscription-info';
import { formatSubscriptionTraffic } from '../../web/src/utils/subscriptionInfo';

test('profile usage adds upload, download, quota and remaining, with the earliest finite expiry', () => {
  const info = aggregateSubscriptionInfo([
    { upload: 1024, download: 2048, total: 10240, expire: 1893456000 },
    { upload: 2048, download: 3072, total: 20480, expire: 1861920000 },
  ]);
  assert.deepEqual(info, {
    upload: 3072, download: 5120, used: 8192, total: 30720, remaining: 22528, expire: 1861920000,
  });
  assert.equal(formatSubscriptionTraffic(info), '8/30 K');
  assert.equal(formatSubscriptionUserinfo(info), 'upload=3072; download=5120; total=30720; expire=1861920000');
});

test('source selection excludes disabled and unselected sources, and counts each source once', () => {
  const sources = [
    { id: 'a', enabled: true },
    { id: 'b', enabled: true },
    { id: 'disabled', enabled: false },
    { id: 'a', enabled: true },
  ];
  assert.deepEqual(selectSubscriptionSources(sources, ['b', 'b', 'disabled', 'missing']), [sources[1]]);
  assert.deepEqual(selectSubscriptionSources(sources), [sources[0], sources[1]]);
  assert.deepEqual(selectSubscriptionSources(sources, []), [sources[0], sources[1]]);
});

test('node-name usage combines with header usage and does not double count notice text', () => {
  const info = aggregateSubscriptionInfo([
    { used: 3072, total: 10240, trafficText: '已用 3 KB / 10 KB' },
    { upload: 1024, download: 4096, total: 20480 },
  ]);
  assert.deepEqual(info, { used: 8192, total: 30720, remaining: 22528 });
  assert.equal(formatSubscriptionUserinfo(info), 'upload=0; download=8192; total=30720');
  assert.equal(formatSubscriptionTraffic(info), '8/30 K');

  const remaining = aggregateSubscriptionInfo([{ remaining: 8192, total: 10240 }, { remaining: 4096, total: 10240 }]);
  assert.deepEqual(remaining, { used: 8192, total: 20480, remaining: 12288 });
});

test('unlimited quota stays unlimited and finite expiry takes precedence over indefinite expiry', () => {
  const info = aggregateSubscriptionInfo([
    { upload: 0, download: 1024, total: 0, expire: 0 },
    { upload: 0, download: 1024, total: 2048, expire: 1893456000 },
  ]);
  assert.deepEqual(info, { upload: 0, download: 2048, used: 2048, total: 0, expire: 1893456000 });
  assert.equal(formatSubscriptionUserinfo(info), 'upload=0; download=2048; total=0; expire=1893456000');
  assert.deepEqual(aggregateSubscriptionInfo([{ expire: 0 }, { expire: 0 }]), { expire: 0 });
});

test('missing metadata and incomplete fields do not invent zero usage or quotas', () => {
  assert.equal(aggregateSubscriptionInfo([]), undefined);
  assert.equal(aggregateSubscriptionInfo([undefined, {}]), undefined);
  assert.equal(formatSubscriptionUserinfo(undefined), '');
  assert.deepEqual(aggregateSubscriptionInfo([undefined, { upload: 0, download: 0 }]), { upload: 0, download: 0, used: 0 });
  assert.deepEqual(aggregateSubscriptionInfo([{ upload: 10, download: 20, total: 100 }, { download: 30 }]), { download: 50 });
  assert.equal(formatSubscriptionUserinfo(aggregateSubscriptionInfo([{ remaining: 1024 }])), '');
});

test('invalid or overflowing amounts cannot become a subscription header', () => {
  assert.equal(aggregateSubscriptionInfo([{ total: -1, upload: NaN, download: Infinity }]), undefined);
  assert.equal(aggregateSubscriptionInfo([{ total: Number.MAX_SAFE_INTEGER }, { total: 1 }]), undefined);
  assert.equal(formatSubscriptionUserinfo({ used: 1024.5, total: 2048.75 }), 'upload=0; download=1024; total=2048');
});
