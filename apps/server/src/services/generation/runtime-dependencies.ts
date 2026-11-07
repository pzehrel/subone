import { portableDohUrl, resolveNodeDns } from './node-domain-ranges';
import { defaultMihomoDohEgress } from '../../core/parser/source-doh';
import { isIP } from 'node:net';
import type { AppConfig, ClientType, ProxyGroupItem, ProxyNode, SourceDohReference, SubscriptionSource } from '../../types';
import { GenerationError, generationMetadata, type GenerationPlan, type GenerationDiagnostic } from './types';

type Document = Record<string, any>;
export interface RuntimeInventoryNode {
  node: ProxyNode;
  sourceId: string;
  state: 'enabled' | 'node-disabled' | 'source-disabled' | 'information-only';
}
export interface RuntimeInventory { sources: SubscriptionSource[]; groups: ProxyGroupItem[]; nodes: RuntimeInventoryNode[] }
export function createRuntimeInventory(config: AppConfig): RuntimeInventory {
  return structuredClone({ sources: config.sources, groups: config.proxyGroups, nodes: config.sources.flatMap(source => [
    ...(source.nodes || []).map(node => ({ node, sourceId: source.id, state: !source.enabled ? 'source-disabled' as const : node.enabled === false ? 'node-disabled' as const : 'enabled' as const })),
    ...(source.infoNodes || []).map(node => ({ node, sourceId: source.id, state: 'information-only' as const })),
  ]) });
}
export const resolverTag = (value: any): string | undefined => typeof value === 'string' ? value : value?.server;
export const needsHostnameLookup = (value: unknown): boolean => typeof value === 'string' && !!value && !isIP(value.replace(/^\[(.*)\]$/, '$1'));

/** Exact strategy surface supported by the native projection; collector and adapter share it. */
export function singboxStrategyIssue(format: string | undefined, raw: Document): 'dynamic' | 'parameters' | 'type' | undefined {
  if (['use', 'providers', 'provider', 'filter', 'exclude-filter', 'include-all', 'include-all-proxies', 'include-all-providers'].some(key => key in raw)) return 'dynamic';
  let fields: string[];
  if (format === 'singbox') {
    if (raw.type === 'selector') fields = ['type', 'tag', 'outbounds', 'default', 'interrupt_exist_connections'];
    else if (raw.type === 'urltest') fields = ['type', 'tag', 'outbounds', 'url', 'interval', 'tolerance', 'idle_timeout', 'interrupt_exist_connections'];
    else if (raw.type === 'direct') fields = ['type', 'tag', 'bind_interface', 'inet4_bind_address', 'inet6_bind_address', 'bind_address_no_port', 'routing_mark', 'reuse_addr', 'netns', 'connect_timeout', 'tcp_fast_open', 'tcp_multi_path', 'udp_fragment', 'network_strategy', 'network_type', 'fallback_network_type', 'fallback_delay'];
    else return 'type';
  } else if (format === 'mihomo' && ['select', 'url-test'].includes(raw.type)) fields = ['name', 'type', 'proxies', 'url', 'interval', 'tolerance', 'hidden', 'icon'];
  else return 'type';
  return Object.keys(raw).some(key => !fields.includes(key)) ? 'parameters' : undefined;
}

export interface RuntimePathEntry { kind: 'outbound' | 'resolver'; id: string; label: string; reason?: string }

/** Inspect adopted connections and retained ordinary routing in the final client document. */
export function validateSingboxRuntime(doc: Document, plan: GenerationPlan, nodeTags: ReadonlyMap<string, string[]>): void {
  const outbounds: Document[] = Array.isArray(doc.outbounds) ? doc.outbounds : [];
  const resolvers: Document[] = Array.isArray(doc.dns?.servers) ? doc.dns.servers : [];
  const get = (kind: RuntimePathEntry['kind'], id: string) => (kind === 'resolver' ? resolvers : outbounds).filter(value => value.tag === id);
  const entry = (kind: RuntimePathEntry['kind'], id: string, reason?: string): RuntimePathEntry => {
    const value = get(kind, id)[0];
    const node = id.startsWith('node:') ? plan.inventory.nodes.find(entry => entry.node.id === id.slice(5))?.node : undefined;
    const group = id.startsWith('group:') ? plan.inventory.groups.find(group => group.id === id.slice(6)) : undefined;
    return { kind, id, label: kind === 'resolver' && value?.server ? `DNS ${value.server}` : node?.name || group?.name || id, ...(reason ? { reason } : {}) };
  };
  for (const binding of [...plan.bindings, undefined]) {
    if (binding?.diagnostics.some(diagnostic => diagnostic.severity === 'error')) continue;
    const visited = new Set<string>();
    let issue: Omit<GenerationDiagnostic, 'sourceId' | 'serviceId'> | undefined;
    const visit = (current: RuntimePathEntry, stack: RuntimePathEntry[]): void => {
      if (issue) return;
      const key = `${current.kind}:${current.id}`;
      const repeated = stack.findIndex(value => `${value.kind}:${value.id}` === key);
      if (repeated >= 0) {
        const path = [...stack, current];
        issue = { code: 'source-doh-cycle', severity: 'error', message: `连接依赖循环：${path.map(value => value.label).join(' → ')}`, path };
        return;
      }
      if (visited.has(key)) return;
      const matches = get(current.kind, current.id);
      if (matches.length !== 1) {
        const path = [...stack, current];
        issue = { code: current.kind === 'resolver' ? 'source-doh-bootstrap-missing' : 'source-doh-dependency-missing', severity: 'error', message: `绑定需修复，${matches.length ? '名称不唯一' : '缺少连接依赖'}：${path.map(value => value.label).join(' → ')}`, path };
        return;
      }
      const value = matches[0];
      const nextStack = [...stack, current];
      if (['selector', 'urltest'].includes(value.type) && (!Array.isArray(value.outbounds) || !value.outbounds.length)) {
        issue = { code: 'source-doh-dependency-missing', severity: 'error', message: `绑定需修复，策略组没有可用成员：${nextStack.map(value => value.label).join(' → ')}`, path: nextStack };
        return;
      }
      if (typeof value.detour === 'string' && value.detour) visit(entry('outbound', value.detour, current.kind === 'resolver' ? 'DoH transport' : 'detour'), nextStack);
      if (Array.isArray(value.outbounds)) for (const member of value.outbounds) if (typeof member === 'string') visit(entry('outbound', member, 'selectable member'), nextStack);
      // Retained native DNS resolver fields are constructor dependencies even for IP servers.
      // Source projections omit unused IP lookup fields; template-owned fields stay unchanged.
      if (needsHostnameLookup(value.server) || current.kind === 'resolver' && resolverTag(value.domain_resolver)) {
        const tag = resolverTag(value.domain_resolver ?? (needsHostnameLookup(value.server) ? doc.route?.default_domain_resolver : undefined));
        if (tag) visit(entry('resolver', tag, current.kind === 'resolver' ? 'DoH hostname bootstrap' : 'node server DNS'), nextStack);
        else if (current.kind === 'resolver') {
          issue = { code: 'source-doh-bootstrap-missing', severity: 'error', message: `DoH 域名缺少独立引导解析器：${nextStack.map(value => value.label).join(' → ')}`, path: nextStack };
        }
      }
      visited.add(key);
    };
    if (binding) for (const id of binding.nodeIds) for (const tag of nodeTags.get(id) || []) visit(entry('outbound', tag), []);
    else for (const tag of [...singboxRoutingTargets(doc), ...outbounds.filter(value => Array.isArray(value.outbounds)).map(value => value.tag)]) visit(entry('outbound', tag, 'ordinary routing'), []);
    if (issue) {
      if (binding) binding.diagnostics.push({ ...issue, sourceId: binding.sourceId, serviceId: binding.appliedServiceIds[0] });
      else throw new GenerationError('sing-box 出站引用需修复', { ...generationMetadata(plan), diagnostics: [...generationMetadata(plan).diagnostics, issue] });
    }
  }
}

export interface RuntimeNodeRequirement {
  nodeId: string;
  sourceId?: string;
  state: 'included' | 'omitted' | 'missing' | RuntimeInventoryNode['state'];
  bindingSourceId: string;
  reason: string[];
}
export interface RuntimeGroupRequirement { groupId: string; bindingSourceId: string; reason: string[]; ordinary?: boolean }
export interface RuntimeDependencyCollection { nodes: RuntimeNodeRequirement[]; groups: RuntimeGroupRequirement[] }

type RuntimeDependencyCollector = (plan: GenerationPlan) => RuntimeDependencyCollection;
const collectors = new Map<ClientType, RuntimeDependencyCollector>();
export function registerRuntimeDependencyCollector(target: ClientType, collector: RuntimeDependencyCollector): void { collectors.set(target, collector); }
export function collectRuntimeDependencies(plan: GenerationPlan): RuntimeDependencyCollection {
  if (plan.target.mode === 'nodes') return { nodes: [], groups: [] };
  return collectors.get(plan.target.type)?.(plan) ?? collectSingboxRuntimeDependencies(plan);
}

/** Inventory traversal for dependency completion. It never edits the plan or silently enables objects. */
function collectSingboxRuntimeDependencies(plan: GenerationPlan): RuntimeDependencyCollection {
  const result: RuntimeDependencyCollection = { nodes: [], groups: [] };
  if (plan.target.mode === 'nodes' || plan.target.type !== 'singbox') return result;
  const nodeDns = resolveNodeDns(plan).forNode;
  let template: Document;
  try { template = JSON.parse(plan.templateContent); } catch { return result; }
  const included = new Set([...plan.ordinaryNodes, ...plan.dependencyNodes].map(node => node.id));
  const visited = new Set<string>();
  const sourceOf = (id?: string) => plan.inventory.sources.find(source => source.id === id);
  const once = (key: string): boolean => { if (visited.has(key)) return false; visited.add(key); return true; };
  const sourceReference = (source: SubscriptionSource, name: string): SourceDohReference => {
    if (source.doh?.format === 'mihomo' && name === 'DIRECT') return { kind: 'direct' };
    const nodes = plan.inventory.nodes.filter(entry => entry.sourceId === source.id && (entry.node.originalName ?? entry.node.name) === name);
    const groups = (source.doh?.outbounds || []).filter(group => group.name === name);
    if (nodes.length + groups.length !== 1) return { kind: nodes.length + groups.length ? 'ambiguous' : 'unresolved', name };
    return nodes.length ? { kind: 'source-node', nodeId: nodes[0].node.id, name } : { kind: 'source-group', outboundId: groups[0].id, name };
  };
  const outbound = (source: SubscriptionSource, reference: SourceDohReference | undefined, owner: string, reason: string[]): void => {
    if (reference?.kind === 'source-node') return node(reference.nodeId || '', owner, [...reason, reference.name || reference.nodeId || 'node']);
    if (reference?.kind !== 'source-group' || !once(`${owner}:private:${reference.outboundId}`)) return;
    const group = source.doh?.outbounds.find(group => group.id === reference.outboundId);
    if (!group) return;
    const raw = group.raw as Document;
    if (singboxStrategyIssue(source.doh?.format, raw)) return;
    for (const member of raw.outbounds ?? raw.proxies ?? []) if (typeof member === 'string') outbound(source, sourceReference(source, member), owner, [...reason, group.name]);
    if (typeof raw.detour === 'string') outbound(source, sourceReference(source, raw.detour), owner, [...reason, group.name]);
  };
  const ordinaryGroups = new Set(plan.ordinaryGroupIds);
  const managedGroup = (id: string, owner: string, reason: string[], ordinary = false): void => {
    if (ordinary) ordinaryGroups.add(id);
    if (!once(`${owner}:managed:${id}:${ordinary}`)) return;
    result.groups.push({ groupId: id, bindingSourceId: owner, reason, ordinary });
    const group = plan.inventory.groups.find(group => group.id === id);
    if (!group || ['direct', 'reject'].includes(group.type)) return;
    for (const member of group.proxies || []) templateOutbound(member, owner, [...reason, group.name], ordinary);
    // Mounted candidates follow the same ordinary selection as generated automatic groups.
    const mounts = group.sources ?? group.use;
    const candidatesPool = ordinaryGroups.has(id) ? plan.ordinaryNodes : plan.inventory.nodes.filter(entry => entry.state === 'enabled').map(entry => entry.node);
    let candidates = mounts?.length ? candidatesPool.filter(candidate => {
      const entry = plan.inventory.nodes.find(entry => entry.node.id === candidate.id)!; const source = sourceOf(entry.sourceId); return mounts.includes(entry.sourceId) || !!source && mounts.includes(source.name); }) : plan.ordinaryNodes;
    if (group.filter) { try { const regex = new RegExp(group.filter.replace(/\(\?i\)/gi, ''), 'i'); candidates = candidates.filter(node => regex.test(node.name)); } catch { /* Actual generator reports invalid patterns. */ } }
    if (group.type !== 'relay' && (mounts?.length || group.filter || !group.proxies?.length)) for (const candidate of candidates) node(candidate.id, owner, [...reason, group.name]);
  };
  const templateOutbound = (tag: string, owner: string, reason: string[], ordinary = false): void => {
    const matches = (template.outbounds || []).filter((value: Document) => value.tag === tag);
    if (!matches.length && tag.startsWith('node:')) return node(tag.slice(5), owner, [...reason, tag]);
    if (!matches.length && tag.startsWith('group:')) return managedGroup(tag.slice(6), owner, reason, ordinary);
    const selectedNode = !matches.length && [...plan.ordinaryNodes, ...plan.dependencyNodes].find(node => node.name === tag);
    if (selectedNode) return node(selectedNode.id, owner, [...reason, tag]);
    const selectedGroup = !matches.length && plan.inventory.groups.find(group => group.name === tag);
    if (selectedGroup) return managedGroup(selectedGroup.id, owner, reason, ordinary);
    if (!once(`${owner}:template-outbound:${tag}:${ordinary}`)) return;
    if (matches.length !== 1) return;
    const value = matches[0];
    if (typeof value.detour === 'string') templateOutbound(value.detour, owner, [...reason, tag]);
    for (const member of value.outbounds || []) if (typeof member === 'string') templateOutbound(member, owner, [...reason, tag], ordinary);
    if (needsHostnameLookup(value.server)) resolver(undefined, resolverTag(value.domain_resolver ?? template.route?.default_domain_resolver), owner, [...reason, tag]);
  };
  const resolver = (source: SubscriptionSource | undefined, tag: string | undefined, owner: string, reason: string[]): void => {
    if (!tag || !once(`${owner}:resolver:${source?.id || 'template'}:${tag}`)) return;
    const document = source?.parsedConfig || template;
    const pool = (document.dns as Document | undefined)?.servers;
    const matches = Array.isArray(pool) ? pool.filter((value: Document) => value.tag === tag) : [];
    if (matches.length !== 1) return;
    connection(source, matches[0], owner, [...reason, tag]);
  };
  const connection = (source: SubscriptionSource | undefined, value: Document, owner: string, reason: string[]): void => {
    if (typeof value.detour === 'string') {
      if (source) outbound(source, sourceReference(source, value.detour), owner, reason);
      else templateOutbound(value.detour, owner, reason);
    }
    if (needsHostnameLookup(value.server) || !source && resolverTag(value.domain_resolver)) {
      const document = source?.parsedConfig || template;
      const tag = resolverTag(value.domain_resolver ?? (needsHostnameLookup(value.server) ? (document.route as Document | undefined)?.default_domain_resolver : undefined));
      resolver(source, tag, owner, reason);
    }
  };
  const node = (id: string, owner: string, reason: string[]): void => {
    if (!once(`${owner}:node:${id}`)) return;
    const entry = plan.inventory.nodes.find(entry => entry.node.id === id);
    const state = !entry ? 'missing' : entry.state !== 'enabled' ? entry.state : included.has(id) ? 'included' : 'omitted';
    result.nodes.push({ nodeId: id, sourceId: entry?.sourceId, state, bindingSourceId: owner, reason });
    if (!entry || entry.state !== 'enabled') return;
    const source = sourceOf(entry.sourceId);
    if (!source) return;
    const value = entry.node;
    const detour = value.raw && typeof value.raw === 'object' ? value.raw.detour ?? value.raw['dialer-proxy'] : undefined;
    if (typeof detour === 'string') outbound(source, sourceReference(source, detour), owner, reason);
    const selected = nodeDns.get(id)?.[0];
    const dnsSource = selected?.source || source;
    const service = selected?.service || dnsSource.doh?.services[0];
    if (!needsHostnameLookup(value.server)) return;
    if (!service) return resolver(undefined, resolverTag(template.route?.default_domain_resolver), owner, reason);
    if (typeof service.raw === 'string') {
      const url = new URL(service.url);
      if (url.username || url.password || service.raw.includes('#') && service.raw.slice(service.raw.indexOf('#') + 1).split('&').length > 1) return;
    } else if (!(service.raw && typeof service.raw === 'object' && (service.raw as Document).type === 'https') && !portableDohUrl({ source: dnsSource, service })) return;
    const egress = service.outbound ?? (dnsSource.doh?.format === 'mihomo' ? defaultMihomoDohEgress(service.path, dnsSource.parsedConfig || {}) : dnsSource.doh?.format === 'quantumultx' ? { kind: 'direct' as const } : undefined);
    if (!egress || ['routing', 'ambiguous', 'unresolved'].includes(egress.kind)) return;
    const nextReason = [...reason, service.url];
    outbound(dnsSource, egress, owner, nextReason);
    const raw = typeof service.raw === 'object' && (service.raw as Document)?.type === 'https' ? service.raw as Document : { server: new URL(service.url).hostname };
    if (!needsHostnameLookup(raw.server)) return;
    const ownResolver = raw.domain_resolver ?? (dnsSource.parsedConfig?.route as Document | undefined)?.default_domain_resolver;
    if (resolverTag(ownResolver)) resolver(dnsSource, resolverTag(ownResolver), owner, nextReason);
    else resolver(undefined, resolverTag(template.route?.default_domain_resolver), owner, nextReason);
  };
  const ordinaryOwner = plan.bindings[0]?.sourceId || '';
  const routing = { ...template, route: { ...template.route, ...(plan.rules.some(rule => rule.enabled && rule.type === 'FINAL') ? { final: undefined } : {}) } };
  for (const target of singboxRoutingTargets(routing)) templateOutbound(target, ordinaryOwner, ['sing-box routing', target], true);
  for (const binding of plan.bindings) for (const id of binding.nodeIds) node(id, binding.sourceId, [binding.sourceName]);
  return result;
}

function singboxRoutingTargets(doc: Document): string[] {
  const result: string[] = typeof doc.route?.final === 'string' ? [doc.route.final] : [];
  const visit = (rules: Document[]) => { for (const rule of rules || []) { if (typeof rule.outbound === 'string') result.push(rule.outbound); if (Array.isArray(rule.rules)) visit(rule.rules); } };
  visit(doc.route?.rules);
  return [...new Set(result)];
}
