import { httpApp } from './helpers/http-app';
import assert from 'node:assert/strict';
import yaml from 'js-yaml';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';

const app = httpApp('subone-naming-references-');
const { api } = app;

let upstreamOrigin: string;
let body = '';
const upstream = createServer((_request, response) => response.end(body));

before(async () => {
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const address = upstream.address();
  assert.ok(address && typeof address !== 'string');
  upstreamOrigin = `http://127.0.0.1:${address.port}`;
});
after(async () => {
  await new Promise<void>(resolve => upstream.close(() => resolve()));
});

function template(target: string): string {
  if (target === 'singbox') return JSON.stringify({ log: { disabled: true }, outbounds: [{ type: 'direct', tag: 'DIRECT' }], route: { final: 'First import choice' } });
  if (target === 'mihomo') return yaml.dump({ 'mixed-port': 0, 'external-controller': '', mode: 'rule', proxies: [], 'proxy-groups': [], rules: ['MATCH,First import choice'] });
  if (target === 'egern') return yaml.dump({ proxies: [], policy_groups: [], rules: [{ default: { policy: 'First import choice' } }] });
  if (target === 'quantumultx') return '[general]\n[dns]\n[server_local]\n[server_remote]\n[policy]\n[filter_local]\nfinal, First import choice\n';
  return '[General]\ndns-server = system\n[Proxy]\n[Remote Proxy]\n[Proxy Group]\n[Rule]\nFINAL,First import choice\n';
}

function inspect(target: string, content: string) {
  if (target === 'singbox') {
    const doc = JSON.parse(content);
    return { nodes: doc.outbounds.filter((entry: any) => entry.server).map((entry: any) => entry.tag), groups: doc.outbounds.filter((entry: any) => ['selector', 'urltest'].includes(entry.type) && entry.tag !== 'GLOBAL').map((entry: any) => entry.tag), resources: 0 };
  }
  if (target === 'mihomo') {
    const doc: any = yaml.load(content);
    return { nodes: doc.proxies.map((entry: any) => entry.name), groups: doc['proxy-groups'].map((entry: any) => entry.name), resources: Object.keys(doc['proxy-providers'] || {}).length };
  }
  if (target === 'egern') {
    const doc: any = yaml.load(content);
    const values = (entries: any[]) => entries.map(entry => Object.values(entry)[0] as any);
    return { nodes: values(doc.proxies).map(entry => entry.name), groups: values(doc.policy_groups).map(entry => entry.name), resources: values(doc.policy_groups).reduce((sum, entry) => sum + (entry.urls?.length || 0), 0) };
  }
  const sectionLines = (name: string) => {
    let section = '';
    return content.split('\n').filter(line => {
      if (line.startsWith('[')) { section = line.trim(); return false; }
      return section === name && line.trim() && !/^\s*[#;]/.test(line);
    });
  };
  const qx = target === 'quantumultx';
  return {
    nodes: sectionLines(qx ? '[server_local]' : '[Proxy]').map(line => qx ? line.match(/tag=([^\n]+)$/)![1] : line.split('=')[0].trim()),
    groups: sectionLines(qx ? '[policy]' : '[Proxy Group]').map(line => qx ? line.split('=')[1].split(',')[0].trim() : line.split('=')[0].trim()),
    resources: sectionLines(qx ? '[server_remote]' : '[Remote Proxy]').length,
  };
}

test('six complete targets allocate collision-free names after target characters and protect native and template names', async () => {
  const node = (name: string, index: number) => ({ name, type: 'trojan', server: `192.0.2.${index}`, port: 443, password: 'fixture-password' });
  const source = (await api('/sources', 'POST', { name: 'Collision source', acquisition: 'manual', nameTemplate: '', content: yaml.dump({ proxies: [
    node('Repeated', 70), node('Repeated', 71), node('Repeated (2)', 72), node('Direct', 73), node('Delimiter,=', 74), node('Delimiter__', 75), node('Template owned', 76),
  ] }) })).data;
  assert.equal(source.nodes.length, 7);
  const second = (await api('/sources', 'POST', { name: 'Local collision source', acquisition: 'manual', content: yaml.dump({ proxies: [node('Original local label', 77)] }) })).data;
  assert.equal((await api(`/nodes/${second.nodes[0].id}`, 'PUT', { name: 'Repeated' })).success, true);
  assert.equal((await api('/groups', 'POST', { name: 'Ambiguous name import', type: 'select', proxies: ['Repeated'] })).status, 400);
  const picker = (await api('/groups', 'POST', { name: 'Repeated', type: 'select', proxies: [...source.nodes, ...second.nodes].map((node: any) => `node:${node.id}`) })).data;
  for (const target of ['singbox', 'mihomo', 'loon', 'quantumultx', 'egern', 'shadowrocket']) {
    let content = template(target).replaceAll('First import choice', `group:${picker.id}`);
    if (target === 'singbox') {
      const document = JSON.parse(content); document.outbounds.push({ type: 'socks', tag: 'Template owned', server: '192.0.2.99', server_port: 1080 }); content = JSON.stringify(document);
    } else if (target === 'mihomo') {
      const document = yaml.load(content) as any; document.proxies.push({ name: 'Template owned', type: 'socks5', server: '192.0.2.99', port: 1080 }); content = yaml.dump(document);
    } else if (target === 'egern') {
      const document = yaml.load(content) as any; document.proxies.push({ socks5: { name: 'Template owned', server: '192.0.2.99', port: 1080 } }); content = yaml.dump(document);
    } else if (target === 'quantumultx') content = content.replace('[server_local]', '[server_local]\nsocks5=192.0.2.99:1080, tag=Template owned');
    else content = content.replace('[Proxy]', '[Proxy]\nTemplate owned = socks5,192.0.2.99,1080');
    const tpl = (await api('/templates', 'POST', { name: `${target} namespace`, type: target, content })).data;
    const profile = (await api('/profiles', 'POST', { name: `${target} namespace`, nodeFilter: { mode: 'all', sourceIds: [source.id, second.id] }, selectedGroupIds: [picker.id], selectedRuleIds: ['no-rules'], templates: { [target]: tpl.id } })).data;
    const response = await fetch(`${app.origin}/s/${profile.token}/${target}`);
    const output = await response.text();
    assert.equal(response.status, 200, output);
    const inspected = inspect(target, output);
    const names: string[] = inspected.nodes;
    assert.equal(new Set([...names, ...inspected.groups]).size, names.length + inspected.groups.length, target);
    assert.ok(inspected.groups.includes('Repeated'), target);
    assert.equal(names.length, 9, target);
    assert.equal(new Set(names).size, 9, `${target}: ${names}`);
    assert.ok(names.includes('Direct (2)'), `${target}: ${names}`);
    assert.ok(names.includes('Template owned (2)'), `${target}: ${names}`);
    assert.ok(names.includes('Template owned'), target);
    if (['loon', 'quantumultx', 'shadowrocket'].includes(target)) {
      assert.ok(names.includes('Delimiter__'), target);
      assert.ok(names.includes('Delimiter__ (2)'), target);
    } else {
      assert.ok(names.includes('Delimiter,='), target);
      assert.ok(names.includes('Delimiter__'), target);
    }
    let members: string[];
    if (target === 'singbox') members = JSON.parse(output).outbounds.find((entry: any) => entry.tag === 'Repeated').outbounds;
    else if (target === 'mihomo') members = (yaml.load(output) as any)['proxy-groups'].find((entry: any) => entry.name === 'Repeated').proxies;
    else if (target === 'egern') members = (yaml.load(output) as any).policy_groups.map((entry: any) => Object.values(entry)[0] as any).find((entry: any) => entry.name === 'Repeated').policies;
    else {
      const line = output.split('\n').find(line => target === 'quantumultx' ? /^static=Repeated,/.test(line) : /^Repeated\s*=/.test(line))!;
      members = line.slice(line.indexOf('=') + 1).split(',').slice(1).map(value => value.trim()).filter(value => !value.includes('='));
    }
    assert.deepEqual(new Set(members), new Set(names.filter(name => name !== 'Template owned')), `${target}: ${members}`);
    const preview = await api('/generate/preview', 'POST', { profileId: profile.id, customType: target });
    assert.equal(preview.data, output, preview.message);
    assert.equal(await fetch(`${app.origin}/s/${profile.token}/${target}`).then(response => response.text()), output);
  }
  assert.deepEqual((await api('/sources')).data.find((entry: any) => entry.id === source.id), source);
});

test('a missing imported name remains a repair reference when a new target later uses that name', async () => {
  const saved = await api('/groups', 'POST', { name: 'Missing import owner', type: 'select', proxies: ['Future imported target'] });
  assert.equal(saved.success, true, saved.message);
  assert.deepEqual(saved.data.proxies, ['unresolved:Future imported target']);
  const target = (await api('/groups', 'POST', { name: 'Future imported target', type: 'direct' })).data;
  const renamed = await api(`/groups/${saved.data.id}`, 'PUT', { name: 'Still needs repair' });
  assert.deepEqual(renamed.data.proxies, ['unresolved:Future imported target']);
  const tpl = (await api('/templates', 'POST', { name: 'Unresolved import template', type: 'singbox', content: JSON.stringify({ outbounds: [{ type: 'socks', tag: 'Future imported target', server: '192.0.2.96', server_port: 1080 }] }) })).data;
  const profile = (await api('/profiles', 'POST', { name: 'Unresolved import profile', nodeFilter: { mode: 'manual', selectedNodeIds: [] }, selectedGroupIds: [saved.data.id, target.id], templates: { singbox: tpl.id } })).data;
  await app.restart();
  const preview = await api('/generate/preview', 'POST', { profileId: profile.id, customType: 'singbox' });
  assert.equal(preview.status, 422, JSON.stringify(preview));
});

test('renumbering, refresh, input switching and restart keep explicit groups, node chains, DoH and template slots on their identities', async () => {
  const document = (insert = false) => JSON.stringify({ outbounds: [
    ...(insert ? [{ type: 'shadowsocks', tag: '大阪 inserted', server: '192.0.2.80', server_port: 443, method: 'aes-128-gcm', password: 'inserted' }] : []),
    { type: 'shadowsocks', tag: insert ? '大阪 entry refreshed' : '大阪 entry', server: '192.0.2.81', server_port: 443, method: 'aes-128-gcm', password: 'entry' },
    { type: 'shadowsocks', tag: insert ? '大阪 exit refreshed' : '大阪 exit', server: 'chain.naming.example', server_port: 443, method: 'aes-128-gcm', password: 'exit', detour: insert ? '大阪 entry refreshed' : '大阪 entry' },
  ], dns: { servers: [{ type: 'https', server: '192.0.2.53', detour: insert ? '大阪 entry refreshed' : '大阪 entry' }] } });
  body = document();
  const source = (await api('/sources', 'POST', { name: 'Lifecycle', url: upstreamOrigin })).data;
  const entry = source.nodes[0], exit = source.nodes[1];
  const inner = (await api('/groups', 'POST', { name: 'Lifecycle inner', type: 'select', proxies: [`node:${exit.id}`] })).data;
  const outer = (await api('/groups', 'POST', { name: 'Lifecycle outer', type: 'select', proxies: [`group:${inner.id}`] })).data;
  const content = JSON.stringify({
    dns: { servers: [{ type: 'udp', tag: 'bootstrap', server: '192.0.2.54' }] },
    route: { default_domain_resolver: { server: 'bootstrap' }, final: outer.name, rules: [{ domain_regex: ['大阪 exit'], outbound: inner.name }] },
    outbounds: [{ type: 'socks', tag: 'Template wrapper', server: '192.0.2.90', server_port: 1080, detour: exit.name }],
  });
  const tpl = (await api('/templates', 'POST', { name: 'Lifecycle template', type: 'singbox', content })).data;
  const profile = (await api('/profiles', 'POST', { name: 'Lifecycle profile', nodeFilter: { mode: 'all', sourceIds: [source.id] }, selectedGroupIds: [outer.id], selectedRuleIds: ['no-rules'], templates: { singbox: tpl.id } })).data;
  const check = async (entryName: string, exitName: string, groupName = inner.name) => {
    const response = await fetch(`${app.origin}/s/${profile.token}/singbox`);
    const output = await response.text();
    assert.equal(response.status, 200, output);
    const result = JSON.parse(output);
    assert.equal(result.outbounds.find((node: any) => node.server === '192.0.2.81').tag, entryName);
    assert.equal(result.outbounds.find((node: any) => node.server === 'chain.naming.example').tag, exitName);
    assert.equal(result.outbounds.find((node: any) => node.server === 'chain.naming.example').detour, entryName);
    assert.equal(result.outbounds.find((node: any) => node.tag === 'Template wrapper').detour, exitName);
    assert.deepEqual(result.outbounds.find((node: any) => node.tag === groupName).outbounds, [exitName]);
    assert.deepEqual(result.outbounds.find((node: any) => node.tag === outer.name).outbounds, [groupName]);
    assert.equal(result.dns.servers.find((server: any) => server.type === 'https').detour, entryName);
    assert.deepEqual(result.route.rules.find((rule: any) => rule.domain_regex).domain_regex, ['大阪 exit']);
    assert.equal(result.route.rules.find((rule: any) => rule.domain_regex).outbound, groupName);
    const preview = await api('/generate/preview', 'POST', { profileId: profile.id, customType: 'singbox' });
    assert.equal(preview.data, output, preview.message);
    return output;
  };
  await check('Lifecycle_大阪 01', 'Lifecycle_大阪 02');
  assert.equal((await api(`/nodes/${entry.id}`, 'PUT', { name: '东京入口' })).success, true);
  assert.equal((await api(`/sources/${source.id}`, 'PUT', { name: 'Renamed lifecycle', nameTemplate: '{region} {region_index}' })).success, true);
  assert.equal((await api(`/groups/${inner.id}`, 'PUT', { name: 'Renamed lifecycle inner' })).success, true);
  await check('东京 01', '大阪 01', 'Renamed lifecycle inner');
  body = document(true);
  assert.equal((await api(`/sources/${source.id}/refresh`, 'POST', {})).success, true);
  const latest = () => api('/sources').then(result => result.data.find((item: any) => item.id === source.id));
  let saved = await latest();
  assert.equal(saved.nodes.find((node: any) => node.server === '192.0.2.81').id, entry.id);
  assert.equal(saved.nodes.find((node: any) => node.server === 'chain.naming.example').id, exit.id);
  const refreshed = await check('东京 01', '大阪 02', 'Renamed lifecycle inner');
  body = 'invalid subscription';
  assert.equal((await api(`/sources/${source.id}/refresh`, 'POST', {})).success, false);
  assert.equal(await check('东京 01', '大阪 02', 'Renamed lifecycle inner'), refreshed);
  const switched = await api(`/sources/${source.id}`, 'PUT', { acquisition: 'manual', content: document(true) });
  assert.equal(switched.success, true, switched.message);
  saved = await latest();
  assert.equal(saved.nodes.find((node: any) => node.server === 'chain.naming.example').id, exit.id);
  const other = (await api('/profiles', 'POST', { name: 'Isolated profile', nodeFilter: { mode: 'manual', selectedNodeIds: [entry.id] }, selectedGroupIds: ['no-groups'], selectedRuleIds: ['no-rules'], templates: { singbox: tpl.id } })).data;
  // A temporary preview never changes the saved template or the other downstream's plan.
  const temporary = await api('/generate/preview', 'POST', { profileId: other.id, customType: 'singbox', customTemplate: '{"outbounds":[]}' });
  assert.equal(temporary.success, true, temporary.message);
  assert.equal((await latest()).nodes.find((node: any) => node.id === entry.id).name, '东京入口');
  assert.equal((await api('/templates')).data.find((item: any) => item.id === tpl.id).content, content);
  await app.restart();
  assert.equal(await check('东京 01', '大阪 02', 'Renamed lifecycle inner'), refreshed);
  assert.equal((await api(`/sources/${source.id}`, 'DELETE')).success, true);
  const replacement = (await api('/sources', 'POST', { name: 'Replacement lifecycle', acquisition: 'manual', content: document(true), nameTemplate: '{region} {region_index}' })).data;
  assert.notEqual(replacement.nodes.find((node: any) => node.server === 'chain.naming.example').id, exit.id);
  assert.deepEqual((await api('/groups')).data.find((group: any) => group.id === inner.id).proxies, ['unresolved:大阪 exit refreshed']);
  const broken = await api('/generate/preview', 'POST', { profileId: profile.id, customType: 'singbox' });
  assert.equal(broken.status, 422, JSON.stringify(broken));
});

test('known template members keep their native namespace and never bind to a managed lookalike after removal', async () => {
  const content = JSON.stringify({ outbounds: [{ type: 'socks', tag: 'Known native target', server: '192.0.2.95', server_port: 1080 }] });
  const tpl = (await api('/templates', 'POST', { name: 'Native namespace fixture', type: 'singbox', content })).data;
  const owner = (await api('/groups', 'POST', { name: 'Native namespace owner', type: 'select', proxies: ['Known native target'] })).data;
  assert.deepEqual(owner.proxies, ['template:Known native target']);
  const lookalike = (await api('/groups', 'POST', { name: 'Known native target', type: 'direct' })).data;
  const profile = (await api('/profiles', 'POST', { name: 'Native namespace profile', nodeFilter: { mode: 'manual', selectedNodeIds: [] }, selectedGroupIds: [owner.id, lookalike.id], selectedRuleIds: ['no-rules'], templates: { singbox: tpl.id } })).data;
  const preview = await api('/generate/preview', 'POST', { profileId: profile.id, customType: 'singbox' });
  assert.equal(preview.success, true, preview.message);
  const result = JSON.parse(preview.data);
  assert.deepEqual(result.outbounds.find((entry: any) => entry.tag === owner.name).outbounds, ['Known native target']);
  assert.equal(result.outbounds.find((entry: any) => entry.tag === 'Known native target').server, '192.0.2.95');
  assert.equal((await api(`/templates/${tpl.id}`, 'PUT', { content: '{}' })).success, true);
  assert.equal((await api('/generate/preview', 'POST', { profileId: profile.id, customType: 'singbox' })).status, 422);
  assert.deepEqual((await api(`/groups/${owner.id}`, 'PUT', { name: 'Still a native namespace owner' })).data.proxies, ['template:Known native target']);
  await app.restart();
  assert.equal((await fetch(`${app.origin}/s/${profile.token}/singbox`)).status, 422);
});
