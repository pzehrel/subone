import { defaultMihomoDohEgress } from '../../../core/parser/source-doh';
import type { SourceDohReference } from '../../../types';
import type { GenerationPlan } from '../types';
import { needsHostnameLookup, resolverTag, singboxStrategyIssue } from '../runtime-dependencies';

type Document = Record<string, any>;
class ConnectionIssue extends Error {
  constructor(public code: string, message: string, public severity: 'error' | 'warning' = 'error', public dependencyState?: string) { super(message); }
}

/** Native sing-box 1.14 DNS. Source and template resolver/outbound namespaces remain separate. */
export function adaptSingboxDns(doc: Document, plan: GenerationPlan, nodeTags: ReadonlyMap<string, string[]>): void {
  const selectedTags = new Set([...plan.ordinaryNodes, ...plan.dependencyNodes].flatMap(node => nodeTags.get(node.id) || []));
  for (const outbound of doc.outbounds || []) if (selectedTags.has(outbound.tag)) delete outbound.domain_resolver;
  const servers: Document[] = Array.isArray(doc.dns?.servers) ? doc.dns.servers : [];
  const templateServers = [...servers];
  const usedDnsTags = new Set<string>(servers.map(server => server.tag));
  const usedOutboundTags = new Set<string>((doc.outbounds || []).map((outbound: Document) => outbound.tag));
  const allocate = (base: string, used: Set<string>): string => { let tag = base; let index = 2; while (used.has(tag)) tag = `${base}-${index++}`; used.add(tag); return tag; };

  for (const binding of plan.bindings) {
    const service = binding.services[0];
    const source = plan.inventory.sources.find(source => source.id === binding.sourceId)!;
    const imports: Document[] = [];
    const outboundImports: Document[] = [];
    let committedOutboundCount = 0;
    const mappedDns = new Map<string, string>();
    const mappedOutbounds = new Map<string, string>();
    const sourceDefault = source.doh?.format === 'singbox' ? (source.parsedConfig?.route as Document | undefined)?.default_domain_resolver : undefined;
    const sourceServers = (source.parsedConfig?.dns as Document | undefined)?.servers;

    const sourceReference = (name: string): SourceDohReference => {
      if (source.doh?.format === 'mihomo' && name === 'DIRECT') return { kind: 'direct', name };
      const nodes = plan.inventory.nodes.filter(entry => entry.sourceId === source.id).map(entry => entry.node).filter(node => (node.originalName ?? node.name) === name);
      const groups = (source.doh?.outbounds || []).filter(group => group.name === name);
      if (nodes.length + groups.length > 1) return { kind: 'ambiguous', name };
      if (nodes.length === 1) return { kind: 'source-node', name, nodeId: nodes[0].id };
      if (groups.length === 1) return { kind: 'source-group', name, outboundId: groups[0].id };
      return { kind: 'unresolved', name };
    };
    const materializeOutbound = (reference: SourceDohReference): string | undefined => {
      if (reference.kind === 'direct') return undefined;
      if (reference.kind === 'source-node') {
        const node = [...plan.ordinaryNodes, ...plan.dependencyNodes].find(node => node.id === reference.nodeId);
        const tag = node && nodeTags.get(node.id)?.includes(node.name) ? node.name : undefined;
        if (tag) return tag;
        const state = plan.inventory.nodes.find(entry => entry.node.id === reference.nodeId)?.state || 'missing';
        throw new ConnectionIssue('source-doh-dependency-missing', `绑定需修复，DoH 出站${state === 'enabled' ? '未包含在当前输出' : '不可用'}：${reference.name || reference.nodeId}`, 'error', state === 'enabled' ? 'omitted' : state);
      }
      if (reference.kind !== 'source-group') throw new ConnectionIssue(reference.kind === 'routing' ? 'source-doh-egress-unapplied' : 'source-doh-dependency-missing', `${reference.kind === 'routing' ? '此客户端尚不能采用 DoH 路由出站' : reference.kind === 'ambiguous' ? 'DoH 出站名称不唯一' : 'DoH 出站不存在'}：${reference.name || ''}`, reference.kind === 'routing' ? 'warning' : 'error');
      const group = source.doh?.outbounds.find(group => group.id === reference.outboundId);
      if (!group) throw new ConnectionIssue('source-doh-dependency-missing', `DoH 出站组不存在：${reference.name || reference.outboundId}`);
      if (mappedOutbounds.has(group.id)) return mappedOutbounds.get(group.id)!;
      const raw = group.raw as Document;
      const strategyIssue = singboxStrategyIssue(source.doh?.format, raw);
      if (strategyIssue) throw new ConnectionIssue('source-doh-strategy-unapplied', `DoH 出站组 ${group.name}${strategyIssue === 'dynamic' ? ' 含尚不能确定的动态成员' : strategyIssue === 'type' ? ' 的策略尚不能映射到 sing-box' : ' 的策略参数尚不能完整映射'}`, 'warning');
      let copy: Document;
      if (source.doh?.format === 'singbox' && ['selector', 'urltest', 'direct'].includes(raw.type)) copy = structuredClone(raw);
      else if (source.doh?.format === 'mihomo' && ['select', 'url-test'].includes(raw.type)) {
        copy = { type: raw.type === 'select' ? 'selector' : 'urltest', ...(raw.url ? { url: raw.url } : {}), ...(raw.interval ? { interval: `${raw.interval}s` } : {}), ...(raw.tolerance !== undefined ? { tolerance: raw.tolerance } : {}) };
      } else throw new ConnectionIssue('source-doh-strategy-unapplied', `DoH 出站组 ${group.name} 的策略尚不能映射到 sing-box`, 'warning');
      const tag = allocate(`subone-egress-${binding.sourceId}-${group.name}`, usedOutboundTags);
      mappedOutbounds.set(group.id, tag);
      copy.tag = tag;
      outboundImports.push(copy);
      const members = raw.outbounds ?? raw.proxies;
      if (copy.type !== 'direct') {
        if (!Array.isArray(members) || !members.length || members.some(member => typeof member !== 'string')) throw new ConnectionIssue('source-doh-dependency-missing', `DoH 出站组 ${group.name} 缺少确定的可选成员`);
        copy.outbounds = members.map((name: string) => {
          const resolved = materializeOutbound(sourceReference(name));
          if (resolved) return resolved;
          // Native direct remains a separate private connection definition.
          const key = 'builtin-direct';
          if (!mappedOutbounds.has(key)) { const direct = allocate(`subone-egress-${binding.sourceId}-DIRECT`, usedOutboundTags); mappedOutbounds.set(key, direct); outboundImports.push({ type: 'direct', tag: direct }); }
          return mappedOutbounds.get(key)!;
        });
        if (typeof raw.default === 'string') copy.default = materializeOutbound(sourceReference(raw.default)) ?? mappedOutbounds.get('builtin-direct');
      }
      if (typeof raw.detour === 'string') copy.detour = materializeOutbound(sourceReference(raw.detour));
      return tag;
    };
    const materializeResolver = (tag: string, namespace: 'source' | 'template'): string => {
      const key = `${namespace}:${tag}`;
      if (mappedDns.has(key)) return mappedDns.get(key)!;
      const pool = namespace === 'source' ? sourceServers : templateServers;
      const matches = Array.isArray(pool) ? pool.filter((candidate: Document) => candidate.tag === tag) : [];
      if (matches.length !== 1) throw new ConnectionIssue('source-doh-bootstrap-missing', `DoH 引导解析器${matches.length ? '名称不唯一' : '不存在'}：${tag}`);
      const candidate = matches[0];
      if (!['local', 'udp', 'tcp', 'tls', 'https'].includes(candidate.type)) throw new ConnectionIssue('source-doh-bootstrap-unapplied', `引导解析器 ${tag} 的类型尚不能映射`, 'warning');
      const copy = namespace === 'source' ? structuredClone(candidate) : candidate;
      const outputTag = namespace === 'source' ? allocate(`subone-bootstrap-${binding.sourceId}-${imports.length + 1}`, usedDnsTags) : tag;
      mappedDns.set(key, outputTag);
      if (namespace === 'source') { copy.tag = outputTag; imports.push(copy); }
      if (namespace === 'source' && typeof candidate.detour === 'string') copy.detour = materializeOutbound(sourceReference(candidate.detour));
      // Native DNS startup records resolver fields as dependencies even for IP endpoints.
      // Omit an unused lookup field instead of introducing an artificial startup cycle.
      if (namespace === 'source' && !needsHostnameLookup(candidate.server)) { delete copy.domain_resolver; return outputTag; }
      const reference = candidate.domain_resolver ?? (needsHostnameLookup(candidate.server) ? namespace === 'source' ? sourceDefault : doc.route?.default_domain_resolver : undefined);
      const next = resolverTag(reference);
      if (next) {
        const resolved = materializeResolver(next, namespace);
        if (namespace === 'source') copy.domain_resolver = typeof reference === 'object' ? { ...reference, server: resolved } : { server: resolved };
      } else if (needsHostnameLookup(candidate.server)) throw new ConnectionIssue('source-doh-bootstrap-missing', `引导解析器 ${tag} 的域名缺少独立解析器`);
      return outputTag;
    };

    try {
      for (const node of [...plan.ordinaryNodes, ...plan.dependencyNodes].filter(node => node.sourceId === binding.sourceId)) {
        const original = plan.inventory.nodes.find(entry => entry.node.id === node.id)?.node || node;
        const label = original.raw && typeof original.raw === 'object' ? original.raw.detour ?? original.raw['dialer-proxy'] : undefined;
        if (typeof label !== 'string') continue;
        const tag = materializeOutbound(sourceReference(label));
        const outbound = doc.outbounds.find((outbound: Document) => outbound.tag === node.name);
        if (outbound) { if (tag) outbound.detour = tag; else delete outbound.detour; }
      }
      doc.outbounds.push(...outboundImports);
      committedOutboundCount = outboundImports.length;
      if (!service || !binding.nodeIds.some(id => (nodeTags.get(id) || []).some(tag => needsHostnameLookup((doc.outbounds || []).find((outbound: Document) => outbound.tag === tag)?.server)))) {
        if (service) { binding.status = 'ignored'; binding.method = 'ip-node-no-dns'; }
        continue;
      }
      let adopted: Document;
      if (service.raw && typeof service.raw === 'object' && !Array.isArray(service.raw) && (service.raw as Document).type === 'https') {
        adopted = structuredClone(service.raw as Document); delete adopted.tag; delete adopted.detour;
      } else if (typeof service.raw === 'string' && (!service.raw.includes('#') || service.raw.slice(service.raw.indexOf('#') + 1).split('&').length === 1)) {
        const url = new URL(service.url);
        if (url.username || url.password) throw new ConnectionIssue('source-doh-options-unapplied', '此 DoH 的认证参数尚不能完整映射；保留模板 DNS', 'warning');
        adopted = { type: 'https', server: url.hostname.replace(/^\[(.*)\]$/, '$1'), ...(url.port ? { server_port: Number(url.port) } : {}), path: url.pathname + url.search };
      } else throw new ConnectionIssue('source-doh-options-unapplied', '此 DoH 的连接选项尚不能完整映射；保留模板 DNS', 'warning');
      const egress = service.outbound ?? (source.doh?.format === 'mihomo' ? defaultMihomoDohEgress(service.path, source.parsedConfig || {}) : undefined);
      if (!egress) throw new ConnectionIssue('source-doh-egress-unapplied', '此 DoH 的原生默认出站尚不能映射；保留模板 DNS', 'warning');
      const detour = materializeOutbound(egress);
      if (detour) adopted.detour = detour;
      adopted.tag = allocate(`subone-doh-${binding.sourceId}`, usedDnsTags);
      if (typeof (service.raw as Document)?.tag === 'string') mappedDns.set(`source:${(service.raw as Document).tag}`, adopted.tag);
      const reference = adopted.domain_resolver ?? sourceDefault;
      if (!needsHostnameLookup(adopted.server)) delete adopted.domain_resolver;
      else if (resolverTag(reference)) {
        const tag = materializeResolver(resolverTag(reference)!, 'source');
        adopted.domain_resolver = typeof reference === 'object' ? { ...reference, server: tag } : { server: tag };
      } else if (needsHostnameLookup(adopted.server)) {
        const tag = resolverTag(doc.route?.default_domain_resolver);
        if (!tag) throw new ConnectionIssue('source-doh-bootstrap-missing', 'DoH 域名缺少模板明确提供的独立引导解析器');
        materializeResolver(tag, 'template');
        adopted.domain_resolver = typeof doc.route.default_domain_resolver === 'object' ? { ...doc.route.default_domain_resolver } : { server: tag };
      }
      if (!doc.dns) doc.dns = {};
      if (!Array.isArray(doc.dns.servers)) doc.dns.servers = servers;
      servers.push(...imports, adopted);
      doc.outbounds.push(...outboundImports.slice(committedOutboundCount));
      const names = new Set(binding.nodeIds.flatMap(id => nodeTags.get(id) || []));
      for (const outbound of doc.outbounds) if (names.has(outbound.tag)) outbound.domain_resolver = { server: adopted.tag };
      binding.appliedServiceIds = [service.id]; binding.status = binding.services.length > 1 ? 'degraded' : 'applied'; binding.method = 'singbox-native-domain-resolver';
      if (binding.services.length > 1) binding.diagnostics.push({ code: 'source-doh-first-only', severity: 'warning', sourceId: binding.sourceId, message: `sing-box 节点解析仅采用首项 DoH；其余 ${binding.services.length - 1} 项未生效` });
    } catch (error) {
      if (!(error instanceof ConnectionIssue)) throw error;
      binding.status = 'unapplied'; binding.method = 'template-dns';
      binding.diagnostics.push({ code: error.code, severity: error.severity, message: error.message, sourceId: binding.sourceId, serviceId: service?.id, ...(error.dependencyState ? { dependencyState: error.dependencyState } : {}) });
    }
  }
}
