import { isIP } from 'node:net';
import type { GenerationPlan } from '../types';

type Document = Record<string, any>;
const resolverTag = (value: any): string | undefined => typeof value === 'string' ? value : value?.server;
const hostname = (value: string) => value.replace(/^\[(.*)\]$/, '$1');

/** Native sing-box 1.14 DNS. Source and template resolver namespaces remain separate. */
export function adaptSingboxDns(doc: Document, plan: GenerationPlan, nodeTags: ReadonlyMap<string, string[]>): void {
  // Upstream raw node DNS tags belong to its document, never to the template namespace.
  // The source-owned binding below is the only adopted node resolver in this output.
  const ordinaryTags = new Set(plan.ordinaryNodes.flatMap(node => nodeTags.get(node.id) || []));
  for (const outbound of doc.outbounds || []) if (ordinaryTags.has(outbound.tag)) delete outbound.domain_resolver;
  const servers: Document[] = Array.isArray(doc.dns?.servers) ? doc.dns.servers : [];
  const templateServers = [...servers];
  const usedTags = new Set(servers.map(server => server.tag));
  const allocate = (base: string): string => { let tag = base; let index = 2; while (usedTags.has(tag)) tag = `${base}-${index++}`; usedTags.add(tag); return tag; };
  for (const binding of plan.bindings) {
    if (!binding.services.length) continue;
    const service = binding.services[0];
    const fail = (code: string, message: string) => {
      binding.status = 'unapplied'; binding.method = 'template-dns';
      binding.diagnostics.push({ code, severity: 'error', message, sourceId: binding.sourceId, serviceId: service.id });
    };
    if (service.outbound?.kind !== 'direct') {
      binding.status = 'unapplied'; binding.method = 'template-dns';
      binding.diagnostics.push({ code: 'source-doh-egress-unapplied', severity: 'warning', sourceId: binding.sourceId, serviceId: service.id, message: '此 DoH 的出站尚未采用；保留模板 DNS' });
      continue;
    }
    let adopted: Document;
    if (service.raw && typeof service.raw === 'object' && !Array.isArray(service.raw) && (service.raw as Document).type === 'https') {
      adopted = structuredClone(service.raw as Document);
      delete adopted.tag; delete adopted.detour;
    } else if (typeof service.raw === 'string' && (!service.raw.includes('#') || service.raw.endsWith('#DIRECT'))) {
      const url = new URL(service.url);
      if (url.username || url.password) {
        binding.status = 'unapplied'; binding.method = 'template-dns';
        binding.diagnostics.push({ code: 'source-doh-options-unapplied', severity: 'warning', sourceId: binding.sourceId, serviceId: service.id, message: '此 DoH 的认证参数尚不能完整映射；保留模板 DNS' });
        continue;
      }
      adopted = { type: 'https', server: hostname(url.hostname), ...(url.port ? { server_port: Number(url.port) } : {}), path: url.pathname + url.search };
    } else {
      binding.status = 'unapplied'; binding.method = 'template-dns';
      binding.diagnostics.push({ code: 'source-doh-options-unapplied', severity: 'warning', sourceId: binding.sourceId, serviceId: service.id, message: '此 DoH 的连接选项尚不能完整映射；保留模板 DNS' });
      continue;
    }
    const source = plan.sources.find(source => source.id === binding.sourceId)!;
    const sourceServers = (source.parsedConfig?.dns as Document | undefined)?.servers;
    const sourceDefaultResolver = source.doh?.format === 'singbox' ? (source.parsedConfig?.route as Document | undefined)?.default_domain_resolver : undefined;
    const imports: Document[] = [];
    const mapped = new Map<string, string>();
    const pending = new Set<string>();
    const independent = (tag: string, namespace: 'source' | 'template'): string | undefined => {
      const key = `${namespace}:${tag}`;
      if (pending.has(key)) return undefined;
      if (mapped.has(key)) return mapped.get(key);
      const pool = namespace === 'source' ? sourceServers : templateServers;
      if (!Array.isArray(pool)) return undefined;
      const matches = pool.filter((candidate: Document) => candidate.tag === tag);
      if (matches.length !== 1) return undefined;
      const candidate = matches[0];
      // Independent native direct resolvers only. A detour or an unsupported type needs #20's complete graph.
      if (!['local', 'udp', 'tcp', 'tls', 'https'].includes(candidate.type) || candidate.detour) return undefined;
      pending.add(key);
      const copy = structuredClone(candidate);
      if (candidate.type !== 'local') {
        if (typeof candidate.server !== 'string') { pending.delete(key); return undefined; }
        const needsResolution = !isIP(hostname(candidate.server));
        const reference = candidate.domain_resolver ?? (needsResolution ? namespace === 'source' ? sourceDefaultResolver : doc.route?.default_domain_resolver : undefined);
        if (reference !== undefined || needsResolution) {
          const next = resolverTag(reference);
          const resolved = next && independent(next, namespace);
          if (!resolved) { pending.delete(key); return undefined; }
          copy.domain_resolver = typeof reference === 'object' ? { ...reference, server: resolved } : { server: resolved };
        }
      }
      pending.delete(key);
      if (namespace === 'template') { mapped.set(key, tag); return tag; }
      copy.tag = allocate(`subone-bootstrap-${binding.sourceId}-${imports.length + 1}`);
      mapped.set(key, copy.tag); imports.push(copy); return copy.tag;
    };
    const sourceResolver = adopted.domain_resolver ?? sourceDefaultResolver;
    const explicitSourceResolver = resolverTag(sourceResolver);
    if (explicitSourceResolver) {
      const tag = independent(explicitSourceResolver, 'source');
      if (!tag) { fail('source-doh-bootstrap-missing', '来源 DoH 缺少可独立连接的引导解析器'); continue; }
      adopted.domain_resolver = typeof sourceResolver === 'object' ? { ...sourceResolver, server: tag } : { server: tag };
    } else if (!isIP(hostname(adopted.server))) {
      const explicitTemplateResolver = resolverTag(doc.route?.default_domain_resolver);
      const tag = explicitTemplateResolver && independent(explicitTemplateResolver, 'template');
      if (!tag) { fail('source-doh-bootstrap-missing', 'DoH 域名缺少模板明确提供的独立引导解析器'); continue; }
      adopted.domain_resolver = typeof doc.route.default_domain_resolver === 'object' ? { ...doc.route.default_domain_resolver, server: tag } : { server: tag };
    }
    adopted.tag = allocate(`subone-doh-${binding.sourceId}`);
    if (!doc.dns) doc.dns = {};
    if (!Array.isArray(doc.dns.servers)) doc.dns.servers = servers;
    servers.push(...imports, adopted);
    const names = new Set(binding.nodeIds.flatMap(id => nodeTags.get(id) || []));
    for (const outbound of doc.outbounds || []) if (names.has(outbound.tag)) outbound.domain_resolver = { server: adopted.tag };
    binding.appliedServiceIds = [service.id]; binding.status = binding.services.length > 1 ? 'degraded' : 'applied'; binding.method = 'singbox-native-domain-resolver';
    if (binding.services.length > 1) binding.diagnostics.push({ code: 'source-doh-first-only', severity: 'warning', sourceId: binding.sourceId, message: `sing-box 节点解析仅采用首项 DoH；其余 ${binding.services.length - 1} 项未生效` });
  }
}
