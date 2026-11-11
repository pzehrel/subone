import { httpApp } from './helpers/http-app';
import assert from 'node:assert/strict';
import yaml from 'js-yaml';
import { test } from 'node:test';

const app = httpApp('subone-geography-naming-');
const { api } = app;

const proxy = (name: string, index: number, extra = {}) => ({ name, type: 'trojan', server: `192.0.2.${index}`, port: 443, password: 'fixture-password', ...extra });
async function addSource(name: string, nodes: any[], extra = {}) {
  const saved = await api('/sources', 'POST', { name, acquisition: 'manual', content: yaml.dump({ proxies: nodes }), nameTemplate: '{region}|{region_code}|{region_emoji}|{region_index}', ...extra });
  assert.equal(saved.success, true, saved.message);
  return saved.data;
}
async function profileFor(sources: any[], filter = {}, templateContent?: string) {
  const group = (await api('/groups', 'POST', { name: `Choice ${sources[0].id}`, type: 'select', sources: sources.map(source => source.id) })).data;
  const tpl = (await api('/templates', 'POST', { name: 'Geography template', type: 'mihomo', content: templateContent || yaml.dump({ proxies: [], 'proxy-groups': [], rules: ['MATCH,DIRECT'] }) })).data;
  const saved = await api('/profiles', 'POST', { name: 'Geography', nodeFilter: { mode: 'all', sourceIds: sources.map(source => source.id), ...filter }, selectedGroupIds: [group.id], selectedRuleIds: ['no-rules'], templates: { mihomo: tpl.id } });
  assert.equal(saved.success, true, saved.message);
  return saved.data;
}
async function names(profile: any) {
  const response = await fetch(`${app.origin}/s/${profile.token}/mihomo`);
  const content = await response.text();
  assert.equal(response.status, 200, content);
  return (yaml.load(content) as any).proxies.map((node: any) => node.name);
}

test('geographic aliases retain cities, select the first compatible place and reject conflicting or embedded fragments', async () => {
  const inputs = ['日本·大阪', 'Osaka', '东京·大阪', '大阪·东京', '日本', '中国香港', 'HK', 'HKG', 'Hong Kong', '香港-日本', '专线 X', 'shipping muscle frankfurter', 'GB', '英国', 'United Kingdom London', 'LHR', '台北', '台湾', '美国 LAX', '德国 Frankfurt', '新加坡', '首尔', '巴黎', '温哥华', '悉尼', '埼玉', 'Tai Wan', '圣何塞', '美国 圣何塞', 'Costa Rica San Jose'];
  const source = await addSource('Places', inputs.map((name, index) => proxy(name, index + 1)));
  const profile = await profileFor([source]);
  const expected = ['大阪|JP|🇯🇵|01', '大阪|JP|🇯🇵|02', '东京|JP|🇯🇵|01', '大阪|JP|🇯🇵|03', '日本|JP|🇯🇵|01', '香港|HK|🇭🇰|01', '香港|HK|🇭🇰|02', '香港|HK|🇭🇰|03', '香港|HK|🇭🇰|04', '香港-日本', '专线 X', 'shipping muscle frankfurter', '英国|UK|🇬🇧|01', '英国|UK|🇬🇧|02', '伦敦|UK|🇬🇧|01', '伦敦|UK|🇬🇧|02', '台北|TW|🇹🇼|01', '台湾|TW|🇹🇼|01', '洛杉矶|US|🇺🇸|01', '法兰克福|DE|🇩🇪|01', '新加坡|SG|🇸🇬|01', '首尔|KR|🇰🇷|01', '巴黎|FR|🇫🇷|01', '温哥华|CA|🇨🇦|01', '悉尼|AU|🇦🇺|01', '埼玉|JP|🇯🇵|01', '台湾|TW|🇹🇼|02', '圣何塞', '圣何塞|US|🇺🇸|01', '圣何塞|CR|🇨🇷|01'];
  assert.deepEqual(await names(profile), expected);
  const preview = await api('/generate/preview', 'POST', { profileId: profile.id, customType: 'mihomo' });
  assert.equal(preview.success, true, preview.message);
  assert.deepEqual((yaml.load(preview.data) as any).proxies.map((node: any) => node.name), expected);
});

test('target and pure outputs number only written nodes while each downstream remains isolated', async () => {
  const source = await addSource('Targets', [
    proxy('大阪 SOCKS', 60, { type: 'socks5' }),
    proxy('大阪 gRPC', 61, { network: 'grpc', 'grpc-opts': { 'grpc-service-name': 'fixture' } }),
    proxy('Osaka regular', 62),
    proxy('大阪 disabled', 63),
  ], { nameTemplate: '{region} {region_index}' });
  assert.equal((await api(`/nodes/${source.nodes[3].id}`, 'PUT', { enabled: false })).success, true);
  const profile = await profileFor([source]);
  assert.deepEqual(await names(profile), ['大阪 01', '大阪 02', '大阪 03']);
  const qxTemplate = (await api('/templates', 'POST', { name: 'Target QX', type: 'quantumultx', content: '[general]\n[dns]\n[server_local]\n[policy]\n[filter_local]\nfinal, direct\n' })).data;
  await api(`/profiles/${profile.id}`, 'PUT', { templates: { ...profile.templates, quantumultx: qxTemplate.id } });
  const qx = await fetch(`${app.origin}/s/${profile.token}/quantumultx`);
  const qxText = await qx.text();
  assert.equal(qx.status, 200, qxText);
  assert.deepEqual([...qxText.matchAll(/tag=([^\n]+)$/gm)].map(match => match[1]), ['大阪 01', '大阪 02']);
  const pure = await fetch(`${app.origin}/s/${profile.token}/shadowrocket?format=base64`);
  const links = Buffer.from(await pure.text(), 'base64').toString().split('\n');
  assert.equal(pure.status, 200);
  assert.deepEqual(links.map(link => decodeURIComponent(link.split('#')[1])), ['大阪 01', '大阪 02']);
  assert.match(pure.headers.get('X-SubOne-Diagnostics') || '', /nodes-only-protocol-unsupported/);
  const narrow = await profileFor([source], { includeKeywords: ['regular'] });
  assert.deepEqual(await names(narrow), ['大阪 01']);
  assert.deepEqual(await names(profile), ['大阪 01', '大阪 02', '大阪 03']);
  assert.equal((await api('/sources')).data.find((entry: any) => entry.id === source.id).nodes[2].name, 'Osaka regular');
});

test('explicit dependencies consume their source position, source slices inherit full names and pure nodes exclude unused DNS paths', async () => {
  const saved = await api('/sources', 'POST', { name: 'Dependency places', acquisition: 'manual', nameTemplate: '{region} {region_index}', content: JSON.stringify({
    outbounds: [
      { type: 'trojan', tag: '大阪 DNS exit', server: '192.0.2.71', server_port: 443, password: 'exit' },
      { type: 'trojan', tag: '大阪 ordinary', server: 'ordinary.numbering.example', server_port: 443, password: 'ordinary' },
      { type: 'trojan', tag: '大阪 unrelated', server: '192.0.2.72', server_port: 443, password: 'unused' },
    ], dns: { servers: [{ type: 'https', server: '192.0.2.53', detour: '大阪 DNS exit' }] },
  }) });
  assert.equal(saved.success, true, saved.message);
  const source = saved.data;
  const profile = await profileFor([source], { includeKeywords: ['ordinary'] });
  const template = (await api('/templates', 'POST', { name: 'Dependency counting', type: 'singbox', content: JSON.stringify({ outbounds: [{ type: 'direct', tag: 'DIRECT' }], route: {} }) })).data;
  await api(`/profiles/${profile.id}`, 'PUT', { templates: { ...profile.templates, singbox: template.id } });
  const preview = await api('/generate/preview', 'POST', { profileId: profile.id, customType: 'singbox' });
  assert.equal(preview.success, true, JSON.stringify(preview));
  const document = JSON.parse(preview.data);
  assert.equal(document.outbounds.find((node: any) => node.server === '192.0.2.71').tag, '大阪 01');
  assert.equal(document.outbounds.find((node: any) => node.server === 'ordinary.numbering.example').tag, '大阪 02');
  assert.equal(preview.generation.dependencyNodeCount, 1);
  assert.equal(document.outbounds.filter((node: any) => node.server).length, 2);
  const slice = await fetch(`${app.origin}/s/${profile.token}/source/${source.id}/singbox`);
  assert.equal(slice.status, 200);
  const sliceLinks = Buffer.from(await slice.text(), 'base64').toString();
  assert.match(sliceLinks, /#%E5%A4%A7%E9%98%AA%2002$/);
  assert.doesNotMatch(sliceLinks, /192\.0\.2\.71|192\.0\.2\.72/);
  const pure = await api('/generate/preview', 'POST', { profileId: profile.id, customType: 'shadowrocket', format: 'base64' });
  assert.equal(pure.success, true, JSON.stringify(pure));
  assert.equal(pure.generation.dependencyNodeCount, 0);
  assert.match(Buffer.from(pure.data, 'base64').toString(), /#%E5%A4%A7%E9%98%AA%2001$/);
});

test('country and name filters re-identify the local input and never reuse original geography', async () => {
  const source = await addSource('Local filters', [proxy('香港 original', 80), proxy('日本 original', 81), proxy('日本 erased', 82)], { nameTemplate: '{region} {region_index}' });
  await api(`/nodes/${source.nodes[0].id}`, 'PUT', { name: 'Osaka local' });
  await api(`/nodes/${source.nodes[1].id}`, 'PUT', { name: '香港 local' });
  await api(`/nodes/${source.nodes[2].id}`, 'PUT', { name: 'Unknown local' });
  const jp = await profileFor([source], { countryCodes: ['JP'], includeKeywords: ['local'], includeRegex: '^Osaka' });
  const hk = await profileFor([source], { countryCodes: ['HK'], excludeKeywords: ['original'] });
  assert.deepEqual(await names(jp), ['大阪 01']);
  assert.deepEqual(await names(hk), ['香港 01']);
  const previousRules = (await api('/rules')).data;
  for (const rule of previousRules) await api(`/rules/${rule.id}`, 'PUT', { enabled: false });
  const extraction = await api('/rules', 'POST', { name: 'Local input only', enabled: true, sourceIds: [source.id], targetCountries: ['HK'], includeKeywords: ['local'] });
  assert.equal(extraction.success, true, extraction.message);
  assert.deepEqual(await names(jp), []);
  assert.deepEqual(await names(hk), ['香港 01']);
  await api(`/rules/${extraction.data.id}`, 'DELETE');
  for (const rule of previousRules) await api(`/rules/${rule.id}`, 'PUT', { enabled: rule.enabled });
  await api(`/nodes/${source.nodes[0].id}`, 'PUT', { name: '' });
  assert.deepEqual(await names(jp), []);
  assert.deepEqual(await names(hk), ['香港 01']);
});

test('actual entries keep upstream document order across sources, information exclusions, source slicing and indices above 99', async () => {
  const first = await addSource('First', [proxy('大阪 90', 90), proxy('大阪 information', 91), proxy('大阪 disabled', 92), proxy('大阪 excluded', 93), proxy('Unknown gap', 94), ...Array.from({ length: 99 }, (_, index) => proxy(`Osaka ${98 - index}`, 95 + index))], { nameTemplate: '{upstream_name} {region} {region_index}', trafficNodeRegex: 'information' });
  const second = await addSource('Second', [proxy('大阪 01', 90), proxy('Tokyo 09', 195)], { nameTemplate: '{upstream_name} {region} {region_index}' });
  const disabled = first.nodes.find((node: any) => node.name === '大阪 disabled');
  await api(`/nodes/${disabled.id}`, 'PUT', { enabled: false });
  const profile = await profileFor([second, first], { excludeKeywords: ['excluded'] });
  const output = await names(profile);
  assert.equal(output.length, 103);
  assert.equal(output[0], 'First 大阪 01');
  assert.equal(output[1], 'Unknown gap');
  assert.deepEqual(output.slice(-4), ['First 大阪 99', 'First 大阪 100', 'Second 大阪 101', 'Second 东京 01']);
  assert.deepEqual(await names(profile), output);
  const slice = await fetch(`${app.origin}/s/${profile.token}/source/${second.id}/mihomo`);
  assert.equal(slice.status, 200);
  assert.deepEqual((yaml.load(await slice.text()) as any).proxies.map((node: any) => node.name), ['Second 大阪 101', 'Second 东京 01']);
  // Source membership order never substitutes for the saved upstream order.
  await api(`/sources/${second.id}`, 'PUT', { content: yaml.dump({ proxies: [proxy('Tokyo 09', 195), proxy('大阪 01', 90)] }) });
  assert.deepEqual((await names(profile)).slice(-2), ['Second 东京 01', 'Second 大阪 101']);
  const isolated = await profileFor([second]);
  assert.deepEqual(await names(isolated), ['Second 东京 01', 'Second 大阪 01']);
});

test('the independent QX node output excludes template-only dependencies while an explicit slice inherits complete counts', async () => {
  const source = await addSource('QX dependencies', [proxy('大阪 exit', 210), proxy('大阪 ordinary', 211)], { nameTemplate: '{region} {region_index}' });
  const profile = await profileFor([source], { includeKeywords: ['ordinary'] });
  const tpl = (await api('/templates', 'POST', { name: 'QX dependency counting', type: 'quantumultx', content: '[general]\n[dns]\n[server_local]\n[policy]\nstatic=Needed, 大阪 exit\n[filter_local]\nfinal, direct\n' })).data;
  await api(`/profiles/${profile.id}`, 'PUT', { templates: { ...profile.templates, quantumultx: tpl.id } });
  const full = await fetch(`${app.origin}/s/${profile.token}/quantumultx`);
  const text = await full.text();
  assert.equal(full.status, 200, text);
  assert.match(text, /trojan=192\.0\.2\.211:443,.*tag=大阪 02/);
  assert.match(text, /trojan=192\.0\.2\.210:443,.*tag=大阪 01/);
  const slice = await fetch(`${app.origin}/s/${profile.token}/source/${source.id}/quantumultx`);
  assert.equal(slice.status, 200);
  assert.match(await slice.text(), /tag=大阪 02/);
  const pure = await fetch(`${app.origin}/s/${profile.token}/nodes/qx`);
  const pureText = await pure.text();
  assert.equal(pure.status, 200, pureText);
  assert.match(pureText, /tag=大阪 01/);
  assert.doesNotMatch(pureText, /192\.0\.2\.210/);
});

test('target omission never hides an existing connection capability error', async () => {
  const source = await addSource('Unsupported path', [proxy('大阪 gRPC chained', 220, { network: 'grpc', 'grpc-opts': { 'grpc-service-name': 'fixture' }, 'dialer-proxy': '大阪 exit' }), proxy('大阪 exit', 221)], { nameTemplate: '{region} {region_index}' });
  const profile = await profileFor([source]);
  const tpl = (await api('/templates', 'POST', { name: 'QX unsupported path', type: 'quantumultx', content: '[general]\n[dns]\n[server_local]\n[policy]\n[filter_local]\nfinal, direct\n' })).data;
  await api(`/profiles/${profile.id}`, 'PUT', { templates: { ...profile.templates, quantumultx: tpl.id } });
  const preview = await api('/generate/preview', 'POST', { profileId: profile.id, customType: 'quantumultx' });
  assert.equal(preview.status, 422, JSON.stringify(preview));
  assert.ok(preview.generation.diagnostics.some((diagnostic: any) => diagnostic.code === 'quantumultx-node-chain-unverified'));
});

test('known fallback entries still occupy their place while unknown inputs never consume another place number', async () => {
  const empty = await addSource('Empty template', [proxy('大阪 original', 230), proxy('Unknown original', 231)], { nameTemplate: '' });
  const captured = await addSource('Missing capture', [proxy('Osaka missing', 232), proxy('大阪 x0', 233)], { extractRegex: 'x(?<multiplier>[0-9.]+)', nameTemplate: '{region} {region_index} {multiplier}x' });
  const profile = await profileFor([empty, captured]);
  assert.deepEqual(await names(profile), ['大阪 original', 'Unknown original', 'Osaka missing', '大阪 03 0x']);
});

test('a declared toString capture falls back when missing and retains a matched zero', async () => {
  const source = await addSource('Named captures', [proxy('大阪 P', 234), proxy('大阪 0', 235)], {
    extractRegex: '(?<toString>0)$', nameTemplate: '{toString} {region_index}',
  });
  assert.deepEqual(await names(await profileFor([source])), ['大阪 P', '0 02']);
});

test('country filters honor configured patterns on the current name and canonical stock places', async () => {
  const rule = (await api('/country-rules', 'POST', { name: '冰岛', code: 'IS', emoji: '🇮🇸', pattern: 'Reykjavik' })).data;
  try {
    const source = await addSource('Custom country', [
      proxy('Reykjavik', 236), proxy('shipping muscle frankfurter', 237), proxy('香港-日本', 238),
    ]);
    const filtered = await profileFor([source], { countryCodes: ['IS', 'HK', 'US', 'DE'] });
    assert.deepEqual(await names(filtered), ['Reykjavik']);
    await api('/nodes/' + source.nodes[0].id, 'PUT', { name: 'Tokyo local' });
    assert.deepEqual(await names(filtered), []);
    await api('/profiles/' + filtered.id, 'PUT', { nodeFilter: { mode: 'all', sourceIds: [source.id], countryCodes: ['JP'] } });
    assert.deepEqual(await names(filtered), ['东京|JP|🇯🇵|01']);
    await api('/nodes/' + source.nodes[0].id, 'PUT', { name: '' });
    assert.deepEqual(await names(filtered), []);
  } finally {
    await api('/country-rules/' + rule.id, 'DELETE');
  }
});

test('management geography follows a local name through refresh, restart and clearing', async () => {
  const content = yaml.dump({ proxies: [proxy('Hong Kong original', 240)] });
  const source = (await api('/sources', 'POST', { name: 'Managed places', acquisition: 'manual', content })).data;
  const id = source.nodes[0].id;
  const check = (node: any, name: string, code: string, flag: string) => {
    assert.deepEqual([node.id, node.originalName, node.name, node.countryCode, node.countryEmoji], [id, 'Hong Kong original', name, code, flag]);
    assert.deepEqual(node.raw, source.nodes[0].raw);
  };
  const renamed = await api('/nodes/' + id, 'PUT', { name: 'Tokyo local' });
  check(renamed.data, 'Tokyo local', 'JP', '🇯🇵');
  const refreshed = await api('/sources/' + source.id, 'PUT', { content });
  check(refreshed.data.nodes[0], 'Tokyo local', 'JP', '🇯🇵');
  await app.restart();
  const stored = (await api('/sources')).data.find((entry: any) => entry.id === source.id);
  check(stored.nodes[0], 'Tokyo local', 'JP', '🇯🇵');
  assert.equal((await api('/sources/' + source.id + '/raw')).data.content, content);
  check((await api('/nodes/' + id, 'PUT', { name: '' })).data, 'Hong Kong original', 'HK', '🇭🇰');
  const cleared = (await api('/config')).data.sources.find((entry: any) => entry.id === source.id);
  check(cleared.nodes[0], 'Hong Kong original', 'HK', '🇭🇰');
});

test('the legacy Taiwan flag prefix keeps an explicit Taiwan place in the TW country filter', async () => {
  const source = await addSource('Legacy flag', [proxy('🇨🇳 台湾W01', 241), proxy('🇨🇳 台北', 242), proxy('🇨🇳 大阪', 243)]);
  assert.deepEqual(await names(await profileFor([source], { countryCodes: ['TW'] })), ['台湾|TW|🇹🇼|01', '台北|TW|🇹🇼|01']);
});
