import type { SourceDohService, SubscriptionSource } from '../../../types';
import { resolveGroupNodes } from '../../../core/generators/group-nodes';
import { splitLoonParameters } from '../../node-references';
import { registerRuntimeDependencyCollector, type RuntimeDependencyCollection, needsHostnameLookup, resolverTag } from '../runtime-dependencies';
import { GenerationError, generationMetadata, type GenerationDiagnostic, type GenerationPlan } from '../types';

type Document = Record<string, any>;
function unsupportedService(service: SourceDohService, source: SubscriptionSource): Pick<GenerationDiagnostic, 'code' | 'message'> | undefined {
  if (service.outbound && service.outbound.kind !== 'direct') return { code: 'source-doh-egress-unapplied', message: 'Loon server-dns 未证实可表达此 DoH 出站；保留模板 DNS' };
  const raw = service.raw;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const value = raw as Document;
    const bootstrap = resolverTag(value.domain_resolver ?? value.address_resolver ?? (source.parsedConfig?.route as Document | undefined)?.default_domain_resolver);
    if (bootstrap) {
      const pool = (source.parsedConfig?.dns as Document | undefined)?.servers;
      const exists = Array.isArray(pool) && pool.filter(server => server.tag === bootstrap).length === 1;
      return { code: exists ? 'source-doh-bootstrap-unapplied' : 'source-doh-bootstrap-missing', message: exists ? 'Loon server-dns 没有已证实的独立引导字段；保留模板 DNS' : '来源 DoH 指定的独立引导解析器不存在或名称不唯一；保留模板 DNS' };
    }
    const plainQuanx = source.doh?.format === 'quantumultx' && !value.scope && Array.isArray(value.options) && !value.options.length && Object.keys(value).every(key => ['line', 'value', 'options'].includes(key));
    if (!plainQuanx && (value.type !== 'https' || Object.keys(value).some(key => !['type', 'tag', 'server', 'server_port', 'path'].includes(key)))) return { code: 'source-doh-options-unapplied', message: '此 DoH 的连接选项尚不能完整映射到 Loon；保留模板 DNS' };
  } else if (typeof raw === 'string') {
    const suffix = raw.slice(raw.indexOf('#') + 1);
    if (raw.includes('#') && suffix !== 'DIRECT') return { code: 'source-doh-options-unapplied', message: '此 DoH 的 URL 选项尚不能完整映射到 Loon；保留模板 DNS' };
  } else return { code: 'source-doh-options-unapplied', message: '此 DoH 的连接选项尚不能完整映射到 Loon；保留模板 DNS' };
  const url = new URL(service.url);
  // Native documentation defines a comma-separated list but no escaping inside an element.
  if (url.username || url.password || url.hash || /[,"\r\n]/.test(service.url)) return { code: 'source-doh-options-unapplied', message: '此 DoH 的认证、片段或列表分隔符没有已证实的 Loon 写法；保留模板 DNS' };
  return undefined;
}

/** Loon 3.5.2 (996)+ node-server DNS. Do not infer transport/bootstrap from General DNS. */
export function adaptLoonDns(plan: GenerationPlan): Map<string, readonly string[]> {
  const result = new Map<string, readonly string[]>();
  const hostPatterns: string[] = []; let section = '';
  for (const line of plan.templateContent.split('\n')) {
    const header = /^\s*\[([^\]]+)\]/.exec(line);
    if (header) { section = header[1].toLowerCase(); continue; }
    if (section !== 'host' || /^\s*[#;]/.test(line)) continue;
    const mapping = /^\s*([^=]+?)\s*=\s*(.+)/.exec(line);
    if (mapping && !/^ip-mode:/i.test(mapping[2]) && !/^ssid:/i.test(mapping[1])) hostPatterns.push(mapping[1].toLowerCase());
  }
  const hasHostMapping = (server: string) => hostPatterns.some(pattern => pattern === server.toLowerCase() || pattern.startsWith('*.') && server.toLowerCase().endsWith(pattern.slice(1)));
  for (const binding of plan.bindings) {
    const nodes = [...plan.ordinaryNodes, ...plan.dependencyNodes].filter(node => binding.nodeIds.includes(node.id));
    if (nodes.some(node => node.detourRef || node.detour || node.raw && typeof node.raw === 'object' && (node.raw.detour || node.raw['dialer-proxy']))) {
      binding.status = 'unapplied';
      binding.diagnostics.push({ code: 'loon-node-route-unapplied', severity: 'error', sourceId: binding.sourceId, message: 'Loon 节点连接出站尚不能完整映射；请使用受支持的目标客户端' });
      continue;
    }
    if (!binding.services.length) continue;
    const source = plan.inventory.sources.find(source => source.id === binding.sourceId)!;
    const unsupported = binding.services.flatMap(service => {
      const issue = unsupportedService(service, source);
      return issue ? [{ ...issue, severity: 'warning' as const, sourceId: binding.sourceId, serviceId: service.id }] : [];
    });
    if (unsupported.length) {
      binding.status = 'unapplied'; binding.method = 'template-dns'; binding.diagnostics.push(...unsupported); continue;
    }
    const mappedNodes = nodes.filter(node => !hasHostMapping(node.server));
    if (mappedNodes.length !== nodes.length) binding.diagnostics.push({ code: 'loon-node-dns-host-override', severity: 'warning', sourceId: binding.sourceId, message: '模板 Host 映射优先于节点 server-dns；匹配节点保留 Host 解析方式' });
    if (!mappedNodes.length) { binding.status = 'unapplied'; binding.method = 'template-host-map'; continue; }
    const urls = binding.services.map(service => service.url);
    for (const node of mappedNodes) result.set(node.id, urls);
    binding.status = 'degraded'; binding.method = 'loon-server-dns';
    binding.appliedServiceIds = binding.services.map(service => service.id);
    binding.diagnostics.push({ code: 'loon-doh-transport-unverified', severity: 'warning', sourceId: binding.sourceId, message: '已映射节点 server-dns；Loon 的 DoH 原生出站方式未证实，未确认采用来源的连接路径' });
    if (urls.some(url => needsHostnameLookup(new URL(url).hostname))) binding.diagnostics.push({ code: 'loon-doh-bootstrap-unverified', severity: 'warning', sourceId: binding.sourceId, message: 'DoH 域名所需的独立引导解析方式未证实；仅映射 server-dns，未确认连接可建立' });
  }
  return result;
}

/** Only retained template outbound slots create dependencies; unapplied source DoH does not. */
registerRuntimeDependencyCollector('loon', plan => {
  const result: RuntimeDependencyCollection = { nodes: [], groups: [] };
  const included = new Set([...plan.ordinaryNodes, ...plan.dependencyNodes].map(node => node.id));
  const visited = new Set<string>();
  const owner = plan.bindings[0]?.sourceId || '';
  const visit = (target: string, reason: string[]): void => {
    if (!/^(node|group|template|builtin|unresolved|ambiguous):/.test(target)) {
      const matchingGroups = plan.inventory.groups.filter(group => group.name === target);
      const matchingNodes = plan.inventory.nodes.filter(entry => entry.node.name === target);
      if (matchingGroups.length + matchingNodes.length === 1) target = matchingGroups.length ? `group:${matchingGroups[0].id}` : `node:${matchingNodes[0].node.id}`;
    }
    if (visited.has(target)) return; visited.add(target);
    if (target.startsWith('node:')) {
      const id = target.slice(5); const entry = plan.inventory.nodes.find(entry => entry.node.id === id);
      result.nodes.push({ nodeId: id, sourceId: entry?.sourceId, state: !entry ? 'missing' : entry.state !== 'enabled' ? entry.state : included.has(id) ? 'included' : 'omitted', bindingSourceId: owner, reason });
    } else if (target.startsWith('group:')) {
      const id = target.slice(6); const group = plan.inventory.groups.find(group => group.id === id);
      result.groups.push({ groupId: id, bindingSourceId: owner, reason });
      if (!group || ['direct', 'reject'].includes(group.type)) return;
      for (const member of group.proxies || []) visit(member, [...reason, group.name]);
      if (group.type !== 'relay' && ((group.sources ?? group.use)?.length || group.filter || !group.proxies?.length)) {
        const ordinaryGroup = plan.groups.some(value => value.id === id) && !plan.dependencyGroupIds.includes(id);
        const pool = ordinaryGroup || !(group.sources ?? group.use)?.length ? plan.ordinaryNodes : plan.inventory.nodes.filter(entry => entry.state === 'enabled').map(entry => entry.node);
        for (const node of resolveGroupNodes(group, pool, plan.inventory.sources)) visit(`node:${node.id}`, [...reason, group.name]);
      }
    }
  };
  for (const reference of plan.template?.connectionReferences || []) {
    if (plan.rules.some(rule => rule.enabled && rule.type === 'FINAL') && reference.slot.includes('FINAL,')) continue;
    visit(reference.target, ['Loon template', reference.literal]);
  }
  return result;
});

/** Check only concrete native outbound references; no invented DNS transport edges. */
export function validateLoonRuntime(output: string, plan: GenerationPlan): void {
  const groups = new Map<string, string[]>(); const terminals = new Set<string>(); const ruleTargets: string[] = [];
  let section = '';
  for (const line of output.split('\n')) {
    const trimmed = line.trim(); const header = /^\[([^\]]+)\]/.exec(trimmed);
    if (header) { section = header[1].toLowerCase(); continue; }
    if (!trimmed || /^[#;]/.test(trimmed)) continue;
    const assignment = /^([^=]+?)\s*=\s*(.*)$/.exec(trimmed);
    if (['proxy', 'remote proxy', 'remote filter'].includes(section) && assignment) terminals.add(assignment[1].trim());
    if (section === 'proxy group' && assignment) groups.set(assignment[1].trim(), splitLoonParameters(assignment[2]).slice(1).map(value => value.trim()).filter(value => !value.includes('=')));
    if (section === 'remote rule') {
      const parts = splitLoonParameters(trimmed);
      const policy = parts.find(part => /^\s*policy\s*=/.test(part));
      if (policy) ruleTargets.push(policy.slice(policy.indexOf('=') + 1).trim());
      else if (parts.length > 1 && !parts[1].includes('=')) ruleTargets.push(parts[1].trim());
    }
    if (section === 'rule') {
      const parts = splitLoonParameters(trimmed); let target = parts.length - 1;
      while (target > 0 && /^(no-resolve|src)$/i.test(parts[target].trim())) target--;
      if (target > 0) ruleTargets.push(parts[target].trim());
    }
  }
  // Provider nodes are concrete native declarations fetched from profile-scoped URLs.
  for (const node of [...plan.ordinaryNodes, ...plan.dependencyNodes]) terminals.add(node.name);
  // Keep explicit managed edges visible even when a legacy generator would prune them.
  for (const group of plan.groups) if (group.proxies?.length) groups.set(group.name, [...new Set([...(groups.get(group.name) || []), ...group.proxies.filter(member => plan.dependencyGroupIds.includes(group.id) || !/^(node|unresolved|ambiguous):/.test(member))])]);
  const builtin = /^(DIRECT|REJECT(?:-IMG|-DICT|-ARRAY|-DROP)?|全部节点)$/i;
  let issue: GenerationDiagnostic | undefined;
  const visit = (name: string, stack: string[]) => {
    if (issue || builtin.test(name) || terminals.has(name)) return;
    if (stack.includes(name)) { issue = { code: 'source-doh-cycle', severity: 'error', message: `Loon 出站依赖循环：${[...stack, name].join(' → ')}` }; return; }
    const members = groups.get(name);
    if (!members?.length) { issue = { code: 'loon-outbound-reference-missing', severity: 'error', message: `Loon 出站引用不存在或策略组没有可用成员：${[...stack, name].join(' → ')}` }; return; }
    for (const member of members) visit(member, [...stack, name]);
  };
  for (const name of [...groups.keys(), ...ruleTargets]) visit(name, []);
  if (issue) {
    if (plan.bindings[0]) plan.bindings[0].diagnostics.push({ ...issue, sourceId: plan.bindings[0].sourceId });
    else throw new GenerationError('Loon 出站引用需修复', { ...generationMetadata(plan), diagnostics: [issue] });
  }
}
