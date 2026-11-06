import { GenerationError, generationMetadata, type GenerationPlan } from '../types';
import yaml from 'js-yaml';
import { isIP } from 'node:net';
import { defaultMihomoDohEgress } from '../../../core/parser/source-doh';
import { mihomoDnsFragment, safeMihomoDnsRoute, withMihomoDnsRoute } from '../../../core/mihomo-dns';
import { generateMihomoConfig, nodeToMihomoProxy } from '../../../core/generators/mihomo-generator';
import type { SourceDohReference, SourceDohService, SubscriptionSource } from '../../../types';
import { needsHostnameLookup, registerRuntimeDependencyCollector, type RuntimeDependencyCollection, type RuntimePathEntry } from '../runtime-dependencies';

type Document = Record<string, any>;
class ConnectionIssue extends Error {
  constructor(public code: string, message: string, public severity: 'error' | 'warning' = 'error', public dependencyState?: string) { super(message); }
}
const domain = (server: string): string => server.toLowerCase().replace(/\.$/, '');
function dnsHost(value: string): string {
  if (value === 'system') return '';
  try { return new URL(value.includes('://') ? value : isIP(value) === 6 ? `udp://[${value}]` : `udp://${value}`).hostname.replace(/^\[|\]$/g, ''); } catch { return ''; }
}
const dnsArray = (value: unknown): string[] => Array.isArray(value) ? value.filter((value): value is string => typeof value === 'string') : typeof value === 'string' ? [value] : [];
function policyServices(dns: Document, host: string): string[] {
  const shared = dnsArray(dns['proxy-server-nameserver']);
  const policy = shared.length ? dns['proxy-server-nameserver-policy'] : dns['nameserver-policy'];
  const policies = policy || {};
  const exact = Object.keys(policies).find(key => domain(key) === domain(host));
  const matches = Object.keys(policies).filter(key => key.startsWith('+.') && (domain(host) === domain(key.slice(2)) || domain(host).endsWith('.' + domain(key.slice(2)))));
  const selected = exact || matches.sort((a, b) => b.length - a.length)[0];
  const services = selected ? dnsArray(policies[selected]) : shared.length ? shared : [...dnsArray(dns.nameserver), ...dnsArray(dns.fallback), ...Object.keys(policies).filter(key => key.startsWith('geosite:') || key.startsWith('rule-set:')).flatMap(key => dnsArray(policies[key]))];
  return !shared.length && dns['respect-rules'] === true ? services.map(value => mihomoDnsFragment(value).route ? value : withMihomoDnsRoute(value, 'RULES')) : services;
}
function routingTargets(doc: Document): string[] {
  const rules = [...(doc.rules || []), ...Object.values(doc['sub-rules'] || {}).flat()];
  return [...new Set(rules.flatMap((rule: unknown) => {
    if (typeof rule !== 'string' || /^SUB-RULE,/i.test(rule)) return [];
    const parts = rule.split(','); let index = parts.length - 1;
    while (index > 0 && /^(no-resolve|src)$/i.test(parts[index].trim())) index--;
    return index > 0 ? [parts[index].trim()] : [];
  }))];
}

function conflictingDomains(plan: GenerationPlan): Set<string> {
  const signatures = new Map<string, Set<string>>();
  // Resolve prospective dependencies before adoption: a required proxy can introduce another
  // source's incompatible policy for this same hostname. Do not add it then silently retain it.
  const prospective = collectMihomoRuntimeDependencies(plan, true).nodes.flatMap(requirement => {
    const entry = plan.inventory.nodes.find(entry => entry.node.id === requirement.nodeId);
    return entry?.state === 'enabled' ? [entry.node] : [];
  });
  for (const node of [...new Map([...plan.ordinaryNodes, ...plan.dependencyNodes, ...prospective].map(node => [node.id, node])).values()].filter(node => needsHostnameLookup(node.server))) {
    const source = plan.inventory.sources.find(source => source.id === node.sourceId);
    const dns = source?.parsedConfig?.dns as Document | undefined;
    const signature = JSON.stringify([(source?.doh?.services || []).map(service => [service.url, typeof service.raw === 'string' ? mihomoDnsFragment(service.raw).parameters : service.raw, service.outbound?.kind === 'direct' ? 'direct' : service.outbound]), dns?.['default-nameserver'], dns?.['prefer-h3']]);
    const values = signatures.get(domain(node.server)) || new Set(); values.add(signature); signatures.set(domain(node.server), values);
  }
  return new Set([...signatures].filter(([, values]) => values.size > 1).map(([host]) => host));
}

/** Mihomo 1.19.33 policies resolve proxy SERVER domains, never arbitrary node identities. */
export function adaptMihomoDns(doc: Document, plan: GenerationPlan): void {
  const conflicts = conflictingDomains(plan);
  const used = new Set<string>([...(doc.proxies || []), ...(doc['proxy-groups'] || [])].map(value => value.name));
  const allocate = (base: string): string => { let name = base; let suffix = 2; while (used.has(name)) name = `${base}-${suffix++}`; used.add(name); return name; };
  for (const binding of plan.bindings) {
    const source = plan.inventory.sources.find(source => source.id === binding.sourceId)!;
    const mapped = new Map<string, string>();
    const imports: Document[] = [];
    let committedProxyCount = (doc.proxies || []).length;
    const materialize = (reference: SourceDohReference): string => {
      if (reference.kind === 'direct') return 'DIRECT';
      if (reference.kind === 'source-node') {
        const node = [...plan.ordinaryNodes, ...plan.dependencyNodes].find(node => node.id === reference.nodeId);
        if (!node) {
          const state = plan.inventory.nodes.find(entry => entry.node.id === reference.nodeId)?.state || 'missing';
          throw new ConnectionIssue('source-doh-dependency-missing', `绑定需修复，DoH 出站不可用：${reference.name || reference.nodeId}`, 'error', state === 'enabled' ? 'omitted' : state);
        }
        if (!(doc.proxies || []).some((value: Document) => value.name === node.name)) doc.proxies.push(nodeToMihomoProxy(node));
        return node.name;
      }
      if (reference.kind !== 'source-group') throw new ConnectionIssue(reference.kind === 'routing' ? 'source-doh-egress-unapplied' : 'source-doh-dependency-missing', `${reference.kind === 'routing' ? '尚不能完整映射来源 DoH 路由出站；保留模板 DNS' : reference.kind === 'ambiguous' ? 'DoH 出站名称不唯一' : 'DoH 出站不存在'}：${reference.name || ''}`, reference.kind === 'routing' ? 'warning' : 'error');
      if (mapped.has(reference.outboundId!)) return mapped.get(reference.outboundId!)!;
      const group = source.doh?.outbounds.find(group => group.id === reference.outboundId);
      if (!group) throw new ConnectionIssue('source-doh-dependency-missing', `DoH 出站组不存在：${reference.name}`);
      const raw = group.raw as Document;
      if (mihomoStrategyIssue(source.doh?.format, raw)) throw new ConnectionIssue('source-doh-strategy-unapplied', `DoH 出站组 ${group.name} 的策略或参数尚不能完整映射到 Mihomo；保留模板 DNS`, 'warning');
      if (source.doh?.format === 'singbox' && raw.type === 'direct') return 'DIRECT';
      const name = allocate(`subone-egress-${source.id}-${group.name.replace(/[&=\u0000-\u001f\u007f]/g, '_')}`); mapped.set(group.id, name);
      const copy = source.doh?.format === 'mihomo' ? structuredClone(raw) : { type: raw.type === 'selector' ? 'select' : 'url-test', ...(raw.url ? { url: raw.url } : {}), ...(raw.interval ? { interval: Number(String(raw.interval).replace(/s$/, '')) } : {}), ...(raw.tolerance !== undefined ? { tolerance: raw.tolerance } : {}) };
      copy.name = name; imports.push(copy);
      const members = raw.proxies ?? raw.outbounds;
      if (!Array.isArray(members) || !members.length || members.some(member => typeof member !== 'string')) throw new ConnectionIssue('source-doh-dependency-missing', `DoH 出站组 ${group.name} 缺少确定的可选成员`);
      copy.proxies = members.map((member: string) => materialize(sourceReference(source, member, plan)));
      return name;
    };
    try {
      for (const node of [...plan.ordinaryNodes, ...plan.dependencyNodes].filter(node => node.sourceId === binding.sourceId)) {
        const original = plan.inventory.nodes.find(entry => entry.node.id === node.id)?.node || node;
        const label = original.raw && typeof original.raw === 'object' ? original.raw.detour ?? original.raw['dialer-proxy'] : undefined;
        if (typeof label !== 'string') continue;
        let route: string;
        try { route = materialize(sourceReference(source, label, plan)); }
        catch (error) {
          if (!(error instanceof ConnectionIssue) || error.severity === 'error') throw error;
          throw new ConnectionIssue('mihomo-node-chain-unapplied', `节点 ${node.name} 的连接出站无法完整映射到 Mihomo：${label}`);
        }
        if (!(doc.proxies || []).some((value: Document) => value.name === node.name)) doc.proxies.push(nodeToMihomoProxy(node));
        doc.proxies.find((value: Document) => value.name === node.name)['dialer-proxy'] = route;
      }
      doc['proxy-groups'].push(...imports); imports.length = 0;
      committedProxyCount = doc.proxies.length;
      if (!binding.services.length) continue;
      const nodes = [...plan.ordinaryNodes, ...plan.dependencyNodes].filter(node => binding.nodeIds.includes(node.id) && needsHostnameLookup(node.server));
      if (!nodes.length) { binding.status = 'ignored'; binding.method = 'ip-node-no-dns'; continue; }
      const unavailable = nodes.filter(node => conflicts.has(domain(node.server)));
      const applicable = nodes.filter(node => !conflicts.has(domain(node.server)));
      if (unavailable.length) binding.diagnostics.push({ code: 'source-doh-domain-conflict', severity: 'warning', sourceId: binding.sourceId, message: `Mihomo 不能按来源区分相同节点服务器域名；保留模板 DNS：${[...new Set(unavailable.map(node => domain(node.server)))].join('、')}` });
      if (!applicable.length) { binding.status = 'unapplied'; binding.method = 'template-dns'; continue; }
      const capacity = sourceDnsCapacityIssue(source, doc);
      if (capacity) throw new ConnectionIssue(capacity.code, capacity.message, 'warning');
      const egressCapacity = bindingEgressCapacityIssue(source, binding.services, plan);
      if (egressCapacity) throw new ConnectionIssue(egressCapacity.code, egressCapacity.message, 'warning');
      const missing = ['proxy-server-nameserver', 'default-nameserver', 'nameserver'].find(key => !Array.isArray(doc.dns?.[key]) || !doc.dns[key].length);
      const badBootstrap = (doc.dns?.['default-nameserver'] || []).some((value: unknown) => typeof value !== 'string' || value !== 'system' && !isIP(dnsHost(value)));
      if (missing || badBootstrap || doc.dns?.enable !== true) {
        binding.status = 'unapplied'; binding.method = 'template-dns';
        binding.diagnostics.push({ code: 'source-doh-bootstrap-missing', severity: 'error', sourceId: binding.sourceId, message: `绑定需修复：模板须明确提供 ${missing || (badBootstrap ? 'default-nameserver 的独立 IP 引导解析器' : 'dns.enable')}` });
        continue;
      }
      const services = binding.services.map(service => {
        if (!mihomoServiceSupported(service)) throw new ConnectionIssue('source-doh-options-unapplied', '来源 DoH 连接参数尚不能完整映射到 Mihomo；保留模板 DNS', 'warning');
        const egress = service.outbound ?? (source.doh?.format === 'mihomo' ? defaultMihomoDohEgress(service.path, source.parsedConfig || {}) : undefined);
        if (!egress) throw new ConnectionIssue('source-doh-egress-unapplied', '来源 DoH 默认出站尚不能映射；保留模板 DNS', 'warning');
        const route = materialize(egress);
        if (!safeMihomoDnsRoute(route)) throw new ConnectionIssue('source-doh-egress-unapplied', `Mihomo DNS 片段不能安全表达出站名称：${route}`, 'warning');
        return withMihomoDnsRoute(typeof service.raw === 'string' ? service.raw : service.url, route);
      });
      doc.dns['proxy-server-nameserver-policy'] ||= {};
      doc['proxy-groups'].push(...imports);
      for (const node of applicable) doc.dns['proxy-server-nameserver-policy'][domain(node.server)] = services;
      binding.status = unavailable.length ? 'degraded' : 'applied'; binding.method = 'mihomo-server-domain-policy';
      binding.appliedServiceIds = binding.services.map(service => service.id);
    } catch (error) {
      if (!(error instanceof ConnectionIssue)) throw error;
      doc.proxies.length = committedProxyCount;
      binding.status = 'unapplied'; binding.method = 'template-dns';
      binding.diagnostics.push({ code: error.code, severity: error.severity, sourceId: binding.sourceId, message: error.message, ...(error.dependencyState ? { dependencyState: error.dependencyState } : {}) });
    }
  }
  isolateMihomoCandidates(doc, plan);
}

function isolateMihomoCandidates(doc: Document, plan: GenerationPlan): void {
  if (plan.target.mode === 'nodes') return;
  const dependencyGroups = new Set(plan.dependencyGroupIds);
  const ordinaryNames = new Set(plan.ordinaryNodes.map(node => node.name));
  const ordinaryGroups = new Set(plan.groups.filter(group => !dependencyGroups.has(group.id)).map(group => group.name));
  let template: Document = {};
  try { template = yaml.load(plan.templateContent) as Document || {}; } catch { /* The existing renderer also accepts an empty template. */ }
  for (const group of template['proxy-groups'] || []) ordinaryGroups.add(group.name);
  const hasPrivate = (doc['proxy-groups'] || []).some((group: Document) => !ordinaryGroups.has(group.name));
  if (!plan.dependencyNodes.length && !dependencyGroups.size && !hasPrivate) return;
  // Native Mihomo otherwise constructs GLOBAL from every static definition, including dependencies.
  if (!(doc['proxy-groups'] || []).some((group: Document) => group.name === 'GLOBAL')) {
    const proxies = ['DIRECT', ...doc.proxies.filter((proxy: Document) => ordinaryNames.has(proxy.name) || (template.proxies || []).some((value: Document) => value.name === proxy.name)).map((proxy: Document) => proxy.name), ...doc['proxy-groups'].filter((group: Document) => ordinaryGroups.has(group.name)).map((group: Document) => group.name)];
    doc['proxy-groups'].push({ name: 'GLOBAL', type: 'select', proxies });
  }
  const dynamic = (template['proxy-groups'] || []).filter((group: Document) => group['include-all'] || group['include-all-proxies']);
  if (dynamic.length && plan.dependencyNodes.length) {
    const generation = generationMetadata(plan);
    generation.diagnostics.push({ code: 'mihomo-candidate-isolation-unapplied', severity: 'error', message: `模板动态策略组无法隔离必要依赖节点，请使用明确的普通候选：${dynamic.map((group: Document) => group.name).join('、')}` });
    throw new GenerationError('Mihomo 普通候选需修复', generation);
  }
}

function sourceReference(source: SubscriptionSource, name: string, plan: GenerationPlan): SourceDohReference {
  if (source.doh?.format === 'mihomo' && name === 'DIRECT') return { kind: 'direct' };
  const nodes = plan.inventory.nodes.filter(entry => entry.sourceId === source.id && (entry.node.originalName ?? entry.node.name) === name);
  const groups = source.doh?.outbounds.filter(group => group.name === name) || [];
  if (nodes.length + groups.length !== 1) return { kind: nodes.length + groups.length ? 'ambiguous' : 'unresolved', name };
  return nodes.length ? { kind: 'source-node', name, nodeId: nodes[0].node.id } : { kind: 'source-group', name, outboundId: groups[0].id };
}
function mihomoServiceSupported(service: SourceDohService): boolean {
  if (typeof service.raw === 'string') return true;
  const raw = service.raw as Document;
  return raw?.type === 'https' && !new URL(service.url).search && Object.keys(raw).every(key => ['type', 'tag', 'server', 'server_port', 'path', 'detour'].includes(key));
}
function mihomoStrategyIssue(format: string | undefined, raw: Document): boolean {
  if (format === 'mihomo') return !['select', 'url-test', 'fallback', 'load-balance'].includes(raw.type) || Object.keys(raw).some(key => !['name', 'type', 'proxies', 'url', 'interval', 'tolerance', 'hidden', 'icon', 'lazy', 'timeout', 'max-failed-times', 'expected-status', 'strategy', 'disable-udp'].includes(key));
  if (format !== 'singbox') return true;
  if (raw.type === 'direct') return Object.keys(raw).some(key => !['type', 'tag'].includes(key));
  return !['selector', 'urltest'].includes(raw.type) || Object.keys(raw).some(key => !['type', 'tag', 'outbounds', 'url', 'interval', 'tolerance'].includes(key)) || raw.interval && !/^\d+s$/.test(String(raw.interval));
}
function sourceDnsCapacityIssue(source: SubscriptionSource, doc: Document): { code: string; message: string } | undefined {
  if (source.doh?.format !== 'mihomo') return;
  const dns = source.parsedConfig?.dns as Document | undefined;
  if (Array.isArray(dns?.['default-nameserver']) && dns['default-nameserver'].length && JSON.stringify(dns['default-nameserver']) !== JSON.stringify(doc.dns?.['default-nameserver'])) return { code: 'source-doh-bootstrap-unapplied', message: 'Mihomo 只有共享引导解析器，无法保留此来源不同的 default-nameserver；保留模板 DNS' };
  if (dns?.['prefer-h3'] !== undefined && dns['prefer-h3'] !== (doc.dns?.['prefer-h3'] ?? false)) return { code: 'source-doh-options-unapplied', message: '此来源 prefer-h3 与共享模板不同，尚不能分别映射；保留模板 DNS' };
}
function bindingEgressCapacityIssue(source: SubscriptionSource, services: SourceDohService[], plan: GenerationPlan): { code: string; message: string } | undefined {
  const visited = new Set<string>();
  const strategyUnsupported = (reference: SourceDohReference): boolean => {
    if (reference.kind !== 'source-group' || visited.has(reference.outboundId!)) return false;
    visited.add(reference.outboundId!);
    const group = source.doh?.outbounds.find(group => group.id === reference.outboundId);
    if (!group) return false; // Missing references are repair errors, not capability limitations.
    if (mihomoStrategyIssue(source.doh?.format, group.raw as Document)) return true;
    return dnsArray((group.raw as Document).proxies ?? (group.raw as Document).outbounds).some(member => strategyUnsupported(sourceReference(source, member, plan)));
  };
  for (const service of services) {
    if (!mihomoServiceSupported(service)) return { code: 'source-doh-options-unapplied', message: '来源 DoH 连接参数尚不能完整映射到 Mihomo；保留模板 DNS' };
    const reference = service.outbound ?? (source.doh?.format === 'mihomo' ? defaultMihomoDohEgress(service.path, source.parsedConfig || {}) : undefined);
    if (!reference || reference.kind === 'routing') return { code: 'source-doh-egress-unapplied', message: '来源 DoH 默认或路由出站尚不能完整映射到 Mihomo；保留模板 DNS' };
    if (strategyUnsupported(reference)) return { code: 'source-doh-strategy-unapplied', message: '来源 DoH 出站组的策略或动态成员尚不能完整映射到 Mihomo；保留模板 DNS' };
    if (reference.kind === 'source-node') {
      const node = plan.inventory.nodes.find(entry => entry.node.id === reference.nodeId)?.node;
      if (node && !safeMihomoDnsRoute(node.name)) return { code: 'source-doh-egress-unapplied', message: `Mihomo DNS 片段不能安全表达出站名称：${node.name}` };
    }
  }
}

/** Check the actual final namespace, including provider candidates and retained template transports. */
export function validateMihomoRuntime(doc: Document, plan: GenerationPlan): void {
  const nodes = [...plan.ordinaryNodes, ...plan.dependencyNodes];
  const native = [...(doc.proxies || []), ...(doc['proxy-groups'] || [])];
  const proxies = [...native, ...nodes.filter(node => !native.some(value => value.name === node.name)).map(nodeToMihomoProxy)];
  const array = (value: unknown): string[] => Array.isArray(value) ? value.filter((value): value is string => typeof value === 'string') : typeof value === 'string' ? [value] : [];
  const dns = doc.dns || {};
  for (const binding of [...plan.bindings, ...(plan.target.mode === 'nodes' ? [] : [undefined])]) {
    if (binding?.diagnostics.some(entry => entry.severity === 'error')) continue;
    let issue: { code: string; message: string; path: RuntimePathEntry[] } | undefined;
    const visited = new Set<string>();
    type Entry = RuntimePathEntry;
    const fail = (code: string, message: string, path: Entry[]) => { issue ||= { code, message: `${message}：${path.map(value => value.label).join(' → ')}`, path }; };
    const visit = (entry: Entry, stack: Entry[], value?: string): void => {
      if (issue) return;
      const key = entry.kind + ':' + entry.id;
      if (stack.some(value => value.kind + ':' + value.id === key)) return fail('source-doh-cycle', '连接依赖循环', [...stack, entry]);
      if (visited.has(key)) return;
      const path = [...stack, entry];
      if (entry.kind === 'resolver') {
        const endpoint = value!;
        let fragment: ReturnType<typeof mihomoDnsFragment>;
        try { fragment = mihomoDnsFragment(endpoint); } catch { return fail('source-doh-bootstrap-missing', 'DNS 地址片段无效', path); }
        const route = fragment.route;
        if (route === 'RULES') for (const target of routingTargets(doc)) visit({ kind: 'outbound', id: target, label: target, reason: 'DNS routing rule' }, path);
        else if (route && route !== 'DIRECT') visit({ kind: 'outbound', id: route, label: route, reason: 'DNS transport' }, path);
        const host = dnsHost(endpoint);
        if (!host && endpoint !== 'system') return fail('source-doh-bootstrap-missing', 'DNS 服务器地址无效', path);
        if (needsHostnameLookup(host)) for (const bootstrap of array(dns['default-nameserver'])) visit({ kind: 'resolver', id: bootstrap, label: `DNS ${dnsHost(bootstrap)}`, reason: 'DoH hostname bootstrap' }, path, bootstrap);
      } else {
        if (['DIRECT', 'REJECT', 'PASS', 'COMPATIBLE', 'REJECT-DROP'].includes(entry.id)) return;
        const matches = proxies.filter(value => value.name === entry.id);
        if (matches.length !== 1) return fail('source-doh-dependency-missing', matches.length ? '必要出站名称不唯一' : '缺少必要连接依赖', path);
        const proxy = matches[0];
        if (typeof proxy['dialer-proxy'] === 'string') visit({ kind: 'outbound', id: proxy['dialer-proxy'], label: proxy['dialer-proxy'], reason: 'dialer-proxy' }, path);
        if (Array.isArray(proxy.proxies) || Array.isArray(proxy.use) || proxy['include-all'] || proxy['include-all-proxies'] || proxy['include-all-providers']) {
          const members = [...array(proxy.proxies), ...(plan.groups.find(group => group.name === entry.id)?.proxies || [])];
          // Native 1.19.33 appends every static proxy (not groups), and include-all
          // also replaces use with every provider. Validate those selectable edges.
          const allProxies = proxy['include-all'] || proxy['include-all-proxies'];
          const allProviders = proxy['include-all'] || proxy['include-all-providers'];
          if ((allProxies || allProviders) && (proxy.filter || proxy['exclude-filter'] || proxy['exclude-type'])) return fail('mihomo-dynamic-members-unverified', '原生动态策略组的筛选成员尚不能完整核验，请使用明确成员', path);
          if (allProxies) members.push(...(doc.proxies || []).map((value: Document) => value.name));
          for (const provider of allProviders ? Object.keys(doc['proxy-providers'] || {}) : array(proxy.use)) {
            const source = plan.sources.find(source => source.name.trim() === provider);
            if (!source) return fail('source-doh-dependency-missing', `必要策略组含无法确定的 provider ${provider}`, path);
            let candidates = plan.ordinaryNodes.filter(node => node.sourceId === source.id);
            if (proxy.filter) { try { const pattern = new RegExp(proxy.filter.replace(/\(\?i\)/g, ''), 'i'); candidates = candidates.filter(node => pattern.test(node.name)); } catch { return fail('source-doh-dependency-missing', '必要策略组正则无效', path); } }
            members.push(...candidates.map(node => node.name));
          }
          if (!members.length) return fail('source-doh-dependency-missing', '必要策略组没有可用成员', path);
          for (const member of members) visit({ kind: 'outbound', id: member, label: member, reason: 'selectable member' }, path);
        }
        if (plan.target.mode !== 'nodes' && needsHostnameLookup(proxy.server)) {
          const services = policyServices(dns, proxy.server);
          for (const endpoint of services) visit({ kind: 'resolver', id: endpoint, label: `DNS ${dnsHost(endpoint)}`, reason: 'node server DNS' }, path, endpoint);
        }
      }
      visited.add(key);
    };
    for (const id of binding?.nodeIds || []) {
      const node = nodes.find(node => node.id === id);
      if (node) visit({ kind: 'outbound', id: node.name, label: node.name }, []);
    }
    if (!binding) for (const target of [...routingTargets(doc), ...(doc['proxy-groups'] || []).map((group: Document) => group.name)]) visit({ kind: 'outbound', id: target, label: target, reason: 'ordinary routing' }, []);
    if (issue) {
      if (binding) binding.diagnostics.push({ ...issue, severity: 'error', sourceId: binding.sourceId, serviceId: binding.appliedServiceIds[0] });
      else throw new GenerationError('Mihomo 出站引用需修复', { ...generationMetadata(plan), diagnostics: [...generationMetadata(plan).diagnostics, { ...issue, severity: 'error' }] });
    }
  }
}

/** Inventory-only collector: follows representable source egress and explicit template transports. */
export function collectMihomoRuntimeDependencies(plan: GenerationPlan, prospective = false): RuntimeDependencyCollection {
  const result: RuntimeDependencyCollection = { nodes: [], groups: [] };
  let doc: Document; try { doc = yaml.load(plan.templateContent) as Document || {}; } catch { return result; }
  const included = new Set([...plan.ordinaryNodes, ...plan.dependencyNodes].map(node => node.id));
  const conflicts = prospective ? new Set<string>() : conflictingDomains(plan);
  const visited = new Set<string>();
  const once = (key: string) => { if (visited.has(key)) return false; visited.add(key); return true; };
  const sourceOf = (id?: string) => plan.inventory.sources.find(source => source.id === id);
  const array = (value: unknown): string[] => Array.isArray(value) ? value.filter((value): value is string => typeof value === 'string') : typeof value === 'string' ? [value] : [];
  const privateOutbound = (source: SubscriptionSource, reference: SourceDohReference, owner: string, reason: string[]): void => {
    if (reference.kind === 'source-node') return node(reference.nodeId || '', owner, [...reason, reference.name || reference.nodeId || 'node']);
    if (reference.kind !== 'source-group' || !once(`${owner}:private:${reference.outboundId}`)) return;
    const group = source.doh?.outbounds.find(group => group.id === reference.outboundId);
    if (!group || mihomoStrategyIssue(source.doh?.format, group.raw as Document)) return;
    for (const member of array((group.raw as Document).proxies ?? (group.raw as Document).outbounds)) privateOutbound(source, sourceReference(source, member, plan), owner, [...reason, group.name]);
  };
  const ordinaryGroups = new Set(plan.ordinaryGroupIds);
  const templateOutbound = (name: string, owner: string, reason: string[], ordinary = false): void => {
    const matches = [...(doc.proxies || []), ...(doc['proxy-groups'] || [])].filter(value => value.name === name);
    if (!matches.length && name.startsWith('node:')) return node(name.slice(5), owner, [...reason, name]);
    if (!matches.length && name.startsWith('group:')) return managed(name.slice(6), owner, reason, ordinary);
    if (!matches.length) {
      const selectedNode = [...plan.ordinaryNodes, ...plan.dependencyNodes].find(node => node.name === name);
      if (selectedNode) return node(selectedNode.id, owner, reason);
      const group = plan.inventory.groups.find(group => group.name === name);
      if (group) return managed(group.id, owner, reason, ordinary);
    }
    if (!once(`${owner}:template:${name}:${ordinary}`) || matches.length !== 1) return;
    const value = matches[0];
    if (typeof value['dialer-proxy'] === 'string') templateOutbound(value['dialer-proxy'], owner, [...reason, name]);
    for (const member of array(value.proxies)) templateOutbound(member, owner, [...reason, name], ordinary);
    if (needsHostnameLookup(value.server)) templateDns(policyServices(doc.dns || {}, value.server), owner, [...reason, name]);
  };
  const managed = (id: string, owner: string, reason: string[], ordinary = false): void => {
    if (ordinary) ordinaryGroups.add(id);
    if (!once(`${owner}:managed:${id}:${ordinary}`)) return;
    result.groups.push({ groupId: id, bindingSourceId: owner, reason, ordinary });
    const group = plan.inventory.groups.find(group => group.id === id);
    if (!group || ['direct', 'reject'].includes(group.type)) return;
    for (const member of group.proxies || []) templateOutbound(member, owner, [...reason, group.name], ordinary);
    const mounts = group.sources ?? group.use;
    let candidates = ordinaryGroups.has(id)
      ? plan.ordinaryNodes : plan.inventory.nodes.filter(entry => entry.state === 'enabled').map(entry => entry.node);
    if (mounts?.length) candidates = candidates.filter(node => { const source = sourceOf(node.sourceId); return !!source && (mounts.includes(source.id) || mounts.includes(source.name)); });
    if (group.filter) { try { const regex = new RegExp(group.filter.replace(/\(\?i\)/gi, ''), 'i'); candidates = candidates.filter(node => regex.test(node.name)); } catch { return; } }
    if (mounts?.length || group.filter || group.includeAll || !group.proxies?.length) for (const candidate of candidates) node(candidate.id, owner, [...reason, group.name]);
  };
  const templateDns = (values: unknown, owner: string, reason: string[]): void => {
    for (const value of array(values)) {
      if (!once(`${owner}:dns:${value}`)) continue;
      let route: string | undefined; try { route = mihomoDnsFragment(value).route; } catch { continue; }
      if (route === 'RULES') for (const target of routingTargets(doc)) templateOutbound(target, owner, [...reason, value]);
      else if (route && route !== 'DIRECT') templateOutbound(route, owner, [...reason, value]);
      if (needsHostnameLookup(dnsHost(value))) templateDns(doc.dns?.['default-nameserver'], owner, [...reason, value]);
    }
  };
  const node = (id: string, owner: string, reason: string[]): void => {
    if (!once(`${owner}:node:${id}`)) return;
    const entry = plan.inventory.nodes.find(entry => entry.node.id === id);
    const state = !entry ? 'missing' : entry.state !== 'enabled' ? entry.state : included.has(id) ? 'included' : 'omitted';
    result.nodes.push({ nodeId: id, sourceId: entry?.sourceId, state, bindingSourceId: owner, reason });
    if (!entry || entry.state !== 'enabled') return;
    const source = sourceOf(entry.sourceId); if (!source) return;
    const original = entry.node;
    const detour = original.raw && typeof original.raw === 'object' ? original.raw.detour ?? original.raw['dialer-proxy'] : undefined;
    if (typeof detour === 'string') privateOutbound(source, sourceReference(source, detour, plan), owner, reason);
    if (plan.target.mode === 'nodes' || !needsHostnameLookup(original.server)) return;
    const services = source.doh?.services || [];
    if (!services.length || conflicts.has(domain(original.server))) return templateDns(policyServices(doc.dns || {}, original.server), owner, reason);
    if (sourceDnsCapacityIssue(source, doc) || bindingEgressCapacityIssue(source, services, plan)) return templateDns(policyServices(doc.dns || {}, original.server), owner, reason);
    for (const service of services) {
      const egress = service.outbound ?? defaultMihomoDohEgress(service.path, source.parsedConfig || {});
      privateOutbound(source, egress, owner, [...reason, service.url]);
      if (needsHostnameLookup(new URL(service.url).hostname)) templateDns(doc.dns?.['default-nameserver'], owner, [...reason, service.url]);
    }
  };
  const ordinaryIds = new Set(plan.ordinaryNodes.map(node => node.id));
  if (plan.target.mode !== 'nodes') {
    const ordinaryOwner = plan.bindings[0]?.sourceId || '';
    const routing = { ...doc, rules: (doc.rules || []).filter((rule: unknown) => !(plan.rules.some(rule => rule.enabled && rule.type === 'FINAL') && typeof rule === 'string' && /^(MATCH|FINAL),/i.test(rule))) };
    for (const target of routingTargets(routing)) templateOutbound(target, ordinaryOwner, ['Mihomo routing', target], true);
  }
  for (const binding of plan.bindings) for (const id of binding.nodeIds.filter(id => ordinaryIds.has(id))) node(id, binding.sourceId, [binding.sourceName]);
  return result;
}

registerRuntimeDependencyCollector('mihomo', collectMihomoRuntimeDependencies);

/** Providers carry selected ordinary nodes and their native node-chain references, without DNS. */
export function renderMihomoSource(plan: GenerationPlan, sourceId: string) {
  const nodes = plan.ordinaryNodes.filter(node => node.sourceId === sourceId);
  if (!nodes.length) return { output: yaml.dump({ proxies: [] }), contentType: 'text/yaml; charset=utf-8' };
  const providerPlan = structuredClone(plan);
  providerPlan.target.mode = 'nodes';
  providerPlan.ordinaryNodes = nodes;
  const requiredIds = new Set(collectMihomoRuntimeDependencies(providerPlan).nodes.map(requirement => requirement.nodeId));
  providerPlan.dependencyNodes = [...plan.ordinaryNodes, ...plan.dependencyNodes].filter(node => !nodes.some(ordinary => ordinary.id === node.id) && requiredIds.has(node.id));
  const selectedIds = new Set([...providerPlan.ordinaryNodes, ...providerPlan.dependencyNodes].map(node => node.id));
  providerPlan.bindings = providerPlan.bindings.flatMap(binding => {
    const nodeIds = binding.nodeIds.filter(id => selectedIds.has(id));
    return nodeIds.length ? [{ ...binding, nodeIds, services: [], appliedServiceIds: [], diagnostics: [] }] : [];
  });
  const final = yaml.load(generateMihomoConfig(plan.templateContent, [...plan.ordinaryNodes, ...plan.dependencyNodes], [], [], plan.sources, { expandNodes: true, ordinaryNodeIds: new Set(plan.ordinaryNodes.map(node => node.id)), dependencyGroupIds: new Set(plan.dependencyGroupIds) })) as Record<string, any>;
  adaptMihomoDns(final, providerPlan);
  validateMihomoRuntime(final, providerPlan);
  const generation = generationMetadata(providerPlan);
  if (generation.diagnostics.some(diagnostic => diagnostic.severity === 'error')) throw new GenerationError('节点连接依赖需修复', generation);
  return { output: yaml.dump({ proxies: nodes.map(node => final.proxies.find((proxy: any) => proxy.name === node.name) || nodeToMihomoProxy(node)) }, { indent: 2, lineWidth: -1, noRefs: true }), contentType: 'text/yaml; charset=utf-8' };
}
