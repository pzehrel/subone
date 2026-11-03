import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { fetchAndParseSource, parseRawContent } from '../src/core/parser/fetcher';
import { nodeToMihomoProxy } from '../src/core/generators/mihomo-generator';
import { nodeToQuantumultXProxy } from '../src/core/generators/quantumultx-generator';
import type { SubscriptionSource } from '../src/types/index';

const uuid = '4dd3ade4-8572-4c72-a1fb-3f8741c4c445';
const ss = 'shadowsocks=ss.example.test:443, method=aes-128-gcm, password=example-secret, tag=香港 SS';
const uri = `vless://${uuid}@uri.example.test:443?security=tls#URI`;

function one(content: string, hint = 'auto') {
  const nodes = parseRawContent(content, 'qx-source', 'QuanX 测试', hint);
  assert.equal(nodes.length, 1);
  return nodes[0];
}

test('QuanX parses all native protocols into normalized nodes', () => {
  const content = [
    ss,
    'shadowsocks=ssr.example.test:8443, method=aes-256-cfb, password=secret, ssr-protocol=auth_aes128_md5, ssr-protocol-param=42:token, obfs=tls1.2_ticket_auth, obfs-host=cdn.example.test, tag=SSR',
    `vmess=vmess.example.test:443, method=aes-128-gcm, password=${uuid}, tag=VMess`,
    `vless=vless.example.test:443, method=none, password=${uuid}, tag=VLESS`,
    'trojan=trojan.example.test:443, password=secret, over-tls=true, tag=Trojan',
    'http=http.example.test:8080, username=user, password=secret, tag=HTTP',
    'socks5=socks.example.test:1080, username=user, password=secret, tag=SOCKS',
    'anytls=any.example.test:443, password=secret, over-tls=true, tag=AnyTLS',
  ].join('\n');
  const nodes = parseRawContent(content, 'qx-source', 'QuanX 测试');
  assert.deepEqual(nodes.map(node => node.type), ['ss', 'ssr', 'vmess', 'vless', 'trojan', 'http', 'socks5', 'anytls']);
  assert.equal(nodes[0].method, 'aes-128-gcm');
  assert.equal(nodes[0].password, 'example-secret');
  assert.equal(nodes[0].countryCode, 'HK');
  assert.equal(nodes[2].uuid, uuid);
  assert.equal(nodes[2].cipher, 'aes-128-gcm');
  assert.equal(nodes[3].uuid, uuid);
  assert.equal(nodes[4].tls, true);
  assert.equal(nodes[5].username, 'user');
  assert.equal(nodes[7].tls, true);
  assert.ok(nodes.every(node => node.sourceId === 'qx-source' && node.sourceName === 'QuanX 测试' && typeof node.raw === 'string'));
  assert.equal(new Set(nodes.map(node => node.id)).size, nodes.length);
  assert.deepEqual(parseRawContent(content, 'qx-source', 'QuanX 测试', 'quantumultx').map(node => node.id), nodes.map(node => node.id));
});

test('QuanX supports explicit hints, automatic detection and wrapped Base64', () => {
  const base64 = Buffer.from(ss).toString('base64');
  const wrapped = base64.match(/.{1,24}/g)!.join('\r\n');
  for (const hint of [undefined, 'auto', 'quantumultx', 'quanx', 'qx']) {
    for (const content of [ss, base64, wrapped, Buffer.from(ss).toString('base64url')]) {
      const nodes = parseRawContent(content, 'source', 'Source', hint);
      assert.equal(nodes.length, 1, `${hint}: ${content === ss ? 'plain' : 'base64'}`);
      assert.equal(nodes[0].server, 'ss.example.test');
    }
  }
});

test('QuanX configuration parses only server_local and does not execute or fetch remote resources', () => {
  const content = `\uFEFF[general]\nserver_check_url=https://example.test/check\n[server_remote]\nhttps://example.test/remote, tag=Remote\n${uri}\n[server_local]\n# ignored\n; ${ss}\n// comment\n${ss}\n${uri}\n[filter_local]\nhttp=not-a-node.example.test:80, tag=not a node\n[rewrite_local]\nhttps://example.test/rewrite url reject\n`;
  const nodes = parseRawContent(content);
  assert.deepEqual(nodes.map(node => node.name), ['香港 SS', 'URI']);
  assert.deepEqual(parseRawContent(Buffer.from(content).toString('base64')).map(node => node.name), ['香港 SS', 'URI']);
  assert.deepEqual(parseRawContent(content.replace(/\n/g, '\r')).map(node => node.name), ['香港 SS', 'URI']);
});

test('QuanX mixed resources retain native and universal URI nodes in order', () => {
  assert.deepEqual(parseRawContent(`${uri}\n${ss}\nss://invalid\nhttp=proxy.example.test:3128, tag=HTTP`).map(node => node.name), ['URI', '香港 SS', 'HTTP']);
});

test('QuanX values preserve quoted commas, equals signs and literal URL encoding', () => {
  const node = one('shadowsocks=ss.example.test:443, method=aes-128-gcm, password="a,b=c%3A#value", tag="美国, Los Angeles = 1"');
  assert.equal(node.password, 'a,b=c%3A#value');
  assert.equal(node.name, '美国, Los Angeles = 1');
  assert.equal(one("http=proxy.example.test:8080, username=user, password=it\u0027s-secret, tag=John\u0027s proxy").password, "it's-secret");
  assert.equal(one('http=proxy.example.test:8080, password="a\\\"b\\\\c", tag=Quoted').password, 'a"b\\c');
});

test('QuanX handles bracketed IPv6, missing tags and customized country rules', () => {
  const node = one('socks5=[2001:db8::1234]:1080, tag=IPv6');
  assert.equal(node.server, '2001:db8::1234');
  assert.equal(node.port, 1080);
  assert.ok(one('http=proxy.example.test:8080').name);
  assert.equal(parseRawContent('http=proxy.example.test:80, tag=private-region', undefined, undefined, 'auto', [{ id: 'private', code: 'XY', name: 'Private', emoji: '🌐', pattern: 'private-region' }])[0].countryCode, 'XY');
});

test('QuanX distinguishes simple-obfs TLS from real TLS and preserves WebSocket plugin options', () => {
  const simple = one(`${ss}, obfs=tls, obfs-host=cdn.example.test`);
  assert.notEqual(simple.tls, true);
  assert.equal(simple.plugin, 'obfs');
  assert.equal(simple.pluginOpts.mode, 'tls');
  const secure = one(`${ss}, obfs=over-tls, obfs-host=tls.example.test, tls-verification=false, udp-relay=false`);
  assert.equal(secure.tls, true);
  assert.equal(secure.sni, 'tls.example.test');
  assert.equal(secure.skipCertVerify, true);
  assert.equal(secure.udp, false);
  const websocket = one(`${ss}, obfs=wss, obfs-host=cdn.example.test, obfs-uri=/ws?token=a=b, tls-verification=true`);
  assert.equal(websocket.network, 'ws');
  assert.equal(websocket.tls, true);
  assert.equal(websocket.wsPath, '/ws?token=a=b');
  assert.equal(websocket.wsHeaders?.Host, 'cdn.example.test');
  assert.deepEqual(websocket.pluginOpts, { mode: 'websocket', host: 'cdn.example.test', path: '/ws?token=a=b', tls: true });
  assert.equal(websocket.skipCertVerify, false);
  assert.match(nodeToQuantumultXProxy(websocket), /obfs=wss/);
});

test('QuanX preserves VMess, VLESS and Trojan transports, TLS, Reality and ALPN', () => {
  const vmess = one(`vmess=vmess.example.test:80, method=chacha20-ietf-poly1305, password=${uuid}, obfs=ws, obfs-host=cdn.example.test, obfs-uri=/socket, aead=false`);
  assert.equal(vmess.tls, false);
  assert.equal(vmess.cipher, 'chacha20-poly1305');
  assert.equal(vmess.network, 'ws');
  const vless = one(`vless=vless.example.test:443, password=${uuid}, obfs=over-tls, obfs-host=tls.example.test, reality-base64-pubkey=test-public-key, reality-hex-shortid=abcd, vless-flow=xtls-rprx-vision`);
  assert.equal(vless.tls, true);
  assert.deepEqual(vless.reality, { enabled: true, publicKey: 'test-public-key', shortId: 'abcd' });
  assert.equal(vless.flow, 'xtls-rprx-vision');
  const trojan = one('trojan=trojan.example.test:443, password=secret, obfs=wss, obfs-host=cdn.example.test, obfs-uri=/ws, tls-alpn=02:68:32:08:68:74:74:70:2f:31:2e:31, tls-pubkey-sha256=' + 'ab'.repeat(32));
  assert.deepEqual(trojan.alpn, ['h2', 'http/1.1']);
  assert.deepEqual(trojan.certificatePublicKeySha256, [Buffer.from('ab'.repeat(32), 'hex').toString('base64')]);
  assert.equal(trojan.tls, true);
  assert.equal(trojan.network, 'ws');
  const legacy = one(`vmess=vmess.example.test:443, password=${uuid}, method=none, tls=true, tls-host=tls.example.test`);
  assert.equal(legacy.tls, true);
  assert.equal(legacy.sni, 'tls.example.test');
});

test('QuanX SSR credentials survive normalization and Mihomo output', () => {
  const node = one('shadowsocks=ssr.example.test:443, method=aes-256-cfb, password=secret, ssr-protocol=auth_chain_b, ssr-protocol-param=42:token, obfs=tls1.2_ticket_fastauth, obfs-host=cdn.example.test, tag=SSR');
  const output = nodeToMihomoProxy(node);
  assert.equal(output.type, 'ssr');
  assert.equal(output.cipher, 'aes-256-cfb');
  assert.equal(output.password, 'secret');
  assert.equal(output.protocol, 'auth_chain_b');
  assert.equal(output['protocol-param'], '42:token');
  assert.equal(output.obfs, 'tls1.2_ticket_fastauth');
  assert.equal(output['obfs-param'], 'cdn.example.test');
  assert.match(nodeToQuantumultXProxy(node), /ssr-protocol=auth_chain_b/);
});

test('QuanX skips malformed entries without losing valid neighbors', () => {
  const invalid = [
    'shadowsocks=ss.example.test:0, method=aes-128-gcm, password=secret',
    'http=proxy.example.test:65536',
    'http=proxy.example.test:8x',
    'http=:8080',
    'http=[broken-ipv6]:443',
    'vmess=vmess.example.test:443',
    'shadowsocks=ss.example.test:443, password=secret',
    'unknown=example.test:443, tag=Unknown',
    'trojan=example.test:443, password="unterminated',
  ];
  assert.deepEqual(parseRawContent([...invalid, ss, ...invalid].join('\n')).map(node => node.name), ['香港 SS']);
});

test('QuanX additions preserve existing subscription formats and source raw text', () => {
  assert.equal(one(uri).type, 'vless');
  assert.equal(one(Buffer.from(uri).toString('base64')).type, 'vless');
  assert.equal(one('proxies:\n  - { name: Clash, type: ss, server: clash.example.test, port: 443, cipher: aes-128-gcm, password: secret }').name, 'Clash');
  assert.equal(one(JSON.stringify({ outbounds: [{ tag: 'Sing-box', type: 'shadowsocks', server: 'sb.example.test', server_port: 443, method: 'aes-128-gcm', password: 'secret' }] })).name, 'Sing-box');
  assert.equal(one(ss).raw, ss);
});

test('QuanX fetching uses the format UA, preserves custom UA and separates usage notices', async t => {
  let userAgent = '';
  const server = createServer((request, response) => {
    userAgent = request.headers['user-agent'] || '';
    response.setHeader('Subscription-Userinfo', 'upload=1; download=2; total=100; expire=1893456000');
    response.end(`${ss}\n${ss.replace('香港 SS', '剩余流量：10 GB')}`);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const source: SubscriptionSource = { id: 'quanx', name: 'QuanX', type: 'quantumultx', enabled: true, url: `http://127.0.0.1:${address.port}`, trafficNodeRegex: '剩余流量' };
  const nodes = await fetchAndParseSource(source);
  assert.equal(nodes.length, 1);
  assert.match(userAgent, /Quantumult/i);
  assert.equal(source.infoNodes?.length, 1);
  assert.equal(source.subscriptionInfo?.total, 100);
  source.customUserAgent = 'Custom-Subscription-Client';
  await fetchAndParseSource(source);
  assert.equal(userAgent, source.customUserAgent);
  source.customUserAgent = undefined;
  source.type = 'auto';
  assert.equal((await fetchAndParseSource(source)).length, 1);
  assert.match(userAgent, /ClashMeta/);
});
