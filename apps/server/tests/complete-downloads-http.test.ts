import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import yaml from 'js-yaml';

const targets = ['singbox', 'mihomo', 'loon', 'quantumultx', 'egern', 'shadowrocket'];
const bodies = new Map<string, string>();
const outputs = new Map<string, string>();
const upstream = createServer((request, response) => response.end(bodies.get(request.url || '/') || 'proxies: []'));
let directory: string, child: ChildProcess, origin: string, upstreamOrigin: string;

async function api(path: string, method = 'GET', value?: unknown): Promise<any> {
  const response = await fetch(`${origin}/api${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: value === undefined ? undefined : JSON.stringify(value) });
  const result = await response.json() as any;
  assert.equal(result.success, true, result.message);
  return result.data;
}

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'subone-complete-downloads-'));
  await writeFile(join(directory, 'config.json'), JSON.stringify({ port: 3456, adminPassword: '' }));
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const address = upstream.address(); assert.ok(address && typeof address !== 'string');
  upstreamOrigin = `http://127.0.0.1:${address.port}`;
  child = spawn(process.execPath, ['--import', 'tsx', join(__dirname, 'helpers/http-server.ts')], {
    env: { ...process.env, SUBONE_ROOT: directory }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let errors = ''; child.stderr?.on('data', chunk => { errors += chunk; });
  const message = await Promise.race([once(child, 'message'), once(child, 'exit').then(([code]) => { throw new Error(`Server exited ${code}: ${errors}`); })]);
  origin = `http://127.0.0.1:${message[0].port}`;
});
after(async () => {
  if (child) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; }
  await new Promise<void>(resolve => upstream.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
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

test('every default complete download contains only the selected enabled nodes without a second node-resource fetch', async t => {
  const proxy = (name: string, server: string, type = 'trojan') => ({ name, type, server, port: 443, password: 'fixture-password' });
  bodies.set('/a', yaml.dump({ proxies: [proxy('Selected A', '192.0.2.10'), proxy('Disabled', '192.0.2.12')] }));
  bodies.set('/b', yaml.dump({ proxies: [proxy('Selected B', '192.0.2.11', 'anytls'), proxy('Excluded', '192.0.2.13')] }));
  bodies.set('/unselected', yaml.dump({ proxies: [proxy('Unselected', '192.0.2.99')] }));
  const a = await api('/sources', 'POST', { name: 'Private upstream A', url: upstreamOrigin + '/a' });
  const b = await api('/sources', 'POST', { name: 'Private upstream B', url: upstreamOrigin + '/b' });
  await api('/sources', 'POST', { name: 'Private unselected upstream', url: upstreamOrigin + '/unselected' });
  await api(`/nodes/${a.nodes.find((node: any) => node.name === 'Disabled').id}`, 'PUT', { enabled: false });
  const group = await api('/groups', 'POST', { name: 'First import choice', type: 'select', sources: [a.id, b.id] });
  for (const target of targets) await t.test(target, async () => {
    const tpl = await api('/templates', 'POST', { name: `${target} first import`, type: target, content: template(target) });
    const profile = await api('/profiles', 'POST', { name: 'One downstream subscription', nodeFilter: { mode: 'all', sourceIds: [a.id, b.id], includeRegex: '^(Selected|Disabled)' }, selectedGroupIds: [group.id], selectedRuleIds: ['no-rules'], templates: { [target]: tpl.id } });
    const response = await fetch(`${origin}/s/${profile.token}/${target}`);
    const content = await response.text();
    assert.equal(response.status, 200, content);
    outputs.set(target, content);
    const result = inspect(target, content);
    assert.deepEqual(result.nodes.sort(), ['Selected A', 'Selected B']);
    assert.deepEqual(result.groups, ['First import choice']);
    assert.equal(result.resources, 0, 'complete downloads must not depend on a second node-resource request');
    assert.doesNotMatch(content, /Private upstream|Private unselected|192\.0\.2\.(?:12|13|99)\b/);
    const previewResponse = await fetch(`${origin}/api/generate/preview`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ profileId: profile.id, customType: target }) });
    const preview = await previewResponse.json() as any;
    assert.equal(preview.success, true, preview.message);
    assert.equal(preview.data, content);
  });
});

test('default complete downloads pass native Mihomo and sing-box validation when available', async t => {
  for (const [target, binary, args] of [
    ['mihomo', process.env.SUBONE_TEST_MIHOMO, ['-t', '-f']],
    ['singbox', process.env.SUBONE_SINGBOX_BINARY, ['check', '-c']],
  ] as const) await t.test(target, { skip: !binary }, async () => {
    const content = outputs.get(target); assert.ok(content);
    const path = join(directory, `${target}-complete.conf`);
    await writeFile(path, content);
    const check = spawnSync(binary!, [...args, path], { encoding: 'utf8', timeout: 10000, cwd: directory });
    assert.equal(check.status, 0, check.stderr || check.stdout);
  });
});
