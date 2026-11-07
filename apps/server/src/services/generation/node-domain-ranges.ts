import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';
import { getPublicSuffix } from 'tldts';
import { extractQuanxDomainAliases } from '../../core/parser/source-doh';
import type { SourceDohService, SubscriptionSource } from '../../types';
import { GenerationError, generationMetadata, type GenerationDiagnostic, type GenerationPlan } from './types';

export interface DomainDohService { source: SubscriptionSource; service: SourceDohService }
export interface NodeDomainRange {
  domain: string;
  wildcard: boolean;
  domains: string[];
  nodeIds: string[];
  services: DomainDohService[];
}

export function normalizeNodeDomain(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  const host = value.trim().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host || isIP(host)) return;
  const ascii = domainToASCII(host).toLowerCase();
  if (!ascii || isIP(ascii) || ascii.length > 253 || !ascii.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return;
  return ascii;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${JSON.stringify(key)}:${stable(value)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

/** Connection identity excludes display text, positional paths and generated service IDs. */
export function dohServiceKey({ source, service }: DomainDohService): string {
  let raw: unknown = service.raw;
  if (source.doh?.format === 'quantumultx' && raw && typeof raw === 'object') {
    const value = raw as Record<string, unknown>;
    raw = { scope: value.scope, options: value.options };
  } else if (raw && typeof raw === 'object') {
    const { tag: _tag, ...options } = raw as Record<string, unknown>;
    raw = options;
  }
  const reference = service.outbound;
  const config = source.parsedConfig as Record<string, any> | undefined;
  const original = service.raw as Record<string, unknown> | undefined;
  const sourceResolver = source.doh?.format === 'singbox' && (original?.domain_resolver || original?.address_resolver || config?.route?.default_domain_resolver);
  const bootstrap = source.doh?.format === 'mihomo' ? config?.dns?.['default-nameserver'] : config?.route?.default_domain_resolver;
  const privateBootstrap = Array.isArray(bootstrap) && bootstrap.some(value => typeof value === 'string' && value.includes('#') && !value.endsWith('#DIRECT'));
  return stable({ url: service.url, raw, outbound: reference?.kind === 'direct' ? 'direct' : reference,
    namespace: reference && reference.kind !== 'direct' || sourceResolver || privateBootstrap ? source.id : undefined,
    bootstrap });
}

function sourceAliases(source: SubscriptionSource): Map<string, string> {
  const aliases = new Map<string, string>();
  if (source.doh?.format !== 'quantumultx') return aliases;
  const values = source.doh.domainAliases ?? (source.rawSubscription?.parseStatus === 'success' ? extractQuanxDomainAliases(source.rawSubscription) : {});
  for (const [from, to] of Object.entries(values)) {
    const a = normalizeNodeDomain(from), b = normalizeNodeDomain(to);
    if (a && b) aliases.set(a, b);
  }
  return aliases;
}

/** Recompute from the current output, including newly completed connection dependencies. */
export function resolveNodeDns(plan: GenerationPlan, validateAliases = false): { ranges: NodeDomainRange[]; forNode: Map<string, DomainDohService[]>; aliases: Map<string, string> } {
  if (plan.target.mode === 'nodes') return { ranges: [], forNode: new Map(), aliases: new Map() };
  const records = new Map<string, { nodeIds: string[]; services: DomainDohService[] }>();
  const aliases = new Map<string, string>();
  const conflictingAliases = new Set<string>();
  const sources = new Map(plan.inventory.sources.map(source => [source.id, source]));
  const ownAliases = new Map(plan.inventory.sources.map(source => [source.id, sourceAliases(source)]));
  const add = (domain: string, nodeId: string | undefined, services: DomainDohService[]) => {
    const entry = records.get(domain) || { nodeIds: [], services: [] };
    if (nodeId && !entry.nodeIds.includes(nodeId)) entry.nodeIds.push(nodeId);
    entry.services.push(...services); records.set(domain, entry);
  };
  for (const node of [...plan.ordinaryNodes, ...plan.dependencyNodes]) {
    const domain = normalizeNodeDomain(node.server), source = sources.get(node.sourceId || '');
    if (!domain || !source) continue;
    const services = (source.doh?.services || []).map(service => ({ source, service }));
    add(domain, node.id, services);
    const visited = new Set([domain]); let current = domain;
    while (ownAliases.get(source.id)?.has(current)) {
      const next = ownAliases.get(source.id)!.get(current)!;
      if (aliases.has(current) && aliases.get(current) !== next) conflictingAliases.add(current);
      else aliases.set(current, next);
      if (visited.has(next)) break;
      visited.add(next); add(next, undefined, services); current = next;
    }
  }
  // An alias inherits the final shared resolver set, including DoH borrowed from another source.
  for (let round = 0; round < aliases.size; round++) {
    let changed = false;
    for (const [from, to] of aliases) {
      const origin = records.get(from), target = records.get(to);
      if (!origin || !target) continue;
      const keys = new Set(target.services.map(dohServiceKey));
      for (const service of origin.services) if (!keys.has(dohServiceKey(service))) {
        keys.add(dohServiceKey(service)); target.services.push(service); changed = true;
      }
    }
    if (!changed) break;
  }
  for (const [from] of aliases) {
    if (!records.get(from)?.services.length) continue;
    const visited = new Set<string>(); let current: string | undefined = from;
    while (current && !visited.has(current)) { visited.add(current); current = aliases.get(current); }
    const cycle = !!current;
    if (!validateAliases || !cycle && !conflictingAliases.has(from)) continue;
    const generation = generationMetadata(plan);
    generation.diagnostics.push({ code: cycle ? 'source-doh-cycle' : 'source-doh-alias-conflict', severity: 'error',
      message: cycle ? `节点域名别名循环：${[...visited, current].join(' → ')}` : `节点域名存在不同的别名目标：${from}` });
    throw new GenerationError('节点域名别名需修复', generation);
  }
  const sourceOrder = new Map(plan.inventory.sources.map((source, i) => [source.id, i]));
  for (const entry of records.values()) {
    entry.services.sort((a, b) => (sourceOrder.get(a.source.id)! - sourceOrder.get(b.source.id)!) || a.source.doh!.services.indexOf(a.service) - b.source.doh!.services.indexOf(b.service));
    const unique = new Map<string, DomainDohService>();
    for (const service of entry.services) if (!unique.has(dohServiceKey(service))) unique.set(dohServiceKey(service), service);
    entry.services = [...unique.values()];
  }
  const forNode = new Map<string, DomainDohService[]>();
  for (const entry of records.values()) for (const id of entry.nodeIds) forNode.set(id, entry.services);
  const signatures = new Map([...records].map(([domain, entry]) => [domain, stable(entry.services.map(dohServiceKey))]));
  const protectedDomains = new Set<string>();
  for (const source of plan.inventory.sources) for (const service of source.doh?.services || []) {
    const host = normalizeNodeDomain(new URL(service.url).hostname); if (host) protectedDomains.add(host);
  }
  const known = new Set(records.keys());
  // Template hostnames with their own resolution intent must not be captured by a wider range.
  for (const match of plan.templateContent.matchAll(/(?:[a-z0-9-]+\.)+[a-z][a-z0-9-]*/gi)) {
    const host = normalizeNodeDomain(match[0]); if (host && !known.has(host)) protectedDomains.add(host);
  }
  const candidates = new Map<string, string[]>();
  for (const [domain, entry] of records) {
    if (!entry.services.length) continue;
    const labels = domain.split('.');
    for (let i = 1; i < labels.length; i++) {
      const base = labels.slice(i).join('.');
      if (getPublicSuffix(base, { allowPrivateDomains: true }) === base) break;
      const members = candidates.get(base) || []; members.push(domain); candidates.set(base, members);
    }
  }
  const covered = new Set<string>(); const ranges: NodeDomainRange[] = [];
  const wildcard = (host: string, base: string) => host.endsWith('.' + base);
  for (const [base, members] of [...candidates].sort(([a], [b]) => a.split('.').length - b.split('.').length || a.localeCompare(b))) {
    const unique = [...new Set(members)];
    if (unique.length < 2 || unique.some(host => covered.has(host))) continue;
    const signature = signatures.get(unique[0]);
    if ([...records.keys()].some(host => wildcard(host, base) && signatures.get(host) !== signature)) continue;
    if ([...protectedDomains].some(host => wildcard(host, base))) continue;
    // Only collapse sibling labels. Clients differ on whether '*' crosses dots.
    if (unique.some(host => host.split('.').length !== base.split('.').length + 1)) continue;
    unique.forEach(host => covered.add(host));
    ranges.push({ domain: base, wildcard: true, domains: unique.sort(), nodeIds: unique.flatMap(host => records.get(host)!.nodeIds), services: records.get(unique[0])!.services });
  }
  for (const [domain, entry] of records) if (entry.services.length && !covered.has(domain)) ranges.push({ domain, wildcard: false, domains: [domain], nodeIds: entry.nodeIds, services: entry.services });
  return { ranges: ranges.sort((a, b) => a.domain.localeCompare(b.domain)), forNode, aliases };
}

export const rangePattern = (range: NodeDomainRange) => `${range.wildcard ? '*.' : ''}${range.domain}`;

/** Conservative overlap check for template Host patterns, where matching precedes DNS. */
export function templateHostConflict(plan: GenerationPlan, pattern: string, ranges: NodeDomainRange[]): boolean {
  const expression = pattern.split('').map(character => character === '*' ? '.*' : character === '?' ? '.' : character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('');
  const matcher = new RegExp(`^${expression}$`, 'i');
  const affected = ranges.filter(range => range.domains.some(domain => matcher.test(domain)));
  if (!affected.length) return false;
  for (const binding of plan.bindings.filter(binding => affected.some(range => range.nodeIds.some(id => binding.nodeIds.includes(id))))) {
    binding.diagnostics.push({ code: 'source-doh-host-override', severity: 'error', sourceId: binding.sourceId,
      message: `模板 Host 范围 ${pattern} 会覆盖来源 DoH，请缩小或移除该映射` });
  }
  return true;
}

/** URL-list fields cannot carry a source-private bootstrap resolver. */
export function portableDohBootstrapIssue({ source, service }: DomainDohService): Pick<GenerationDiagnostic, 'code' | 'message'> | undefined {
  if (source.doh?.format !== 'singbox' || !service.raw || typeof service.raw !== 'object') return;
  const raw = service.raw as Record<string, unknown>;
  const route = source.parsedConfig?.route as Record<string, unknown> | undefined;
  const reference = raw.domain_resolver ?? raw.address_resolver ?? (normalizeNodeDomain(new URL(service.url).hostname) ? route?.default_domain_resolver : undefined);
  const tag = typeof reference === 'string' ? reference : (reference as Record<string, unknown> | undefined)?.server;
  if (!tag) return;
  const pool = (source.parsedConfig?.dns as Record<string, unknown> | undefined)?.servers;
  const exists = Array.isArray(pool) && pool.filter(server => server?.tag === tag).length === 1;
  return { code: exists ? 'source-doh-bootstrap-unapplied' : 'source-doh-bootstrap-missing',
    message: exists ? '当前输出无法保留来源 DoH 的独立引导解析器，保留模板 DNS' : '来源 DoH 的独立引导解析器不存在或名称不唯一，保留模板 DNS' };
}

/** URLs usable by native URL-list DNS fields, without silently dropping connection parameters. */
export function portableDohUrl(entry: DomainDohService): string | undefined {
  const { source, service } = entry;
  if (service.outbound && service.outbound.kind !== 'direct') return;
  if (portableDohBootstrapIssue(entry)) return;
  const url = new URL(service.url);
  if (url.username || url.password || url.hash || /[,"\r\n]/.test(service.url)) return;
  if (typeof service.raw === 'string') {
    if (service.raw.includes('#') && service.raw.slice(service.raw.indexOf('#') + 1) !== 'DIRECT') return;
  } else if (service.raw && typeof service.raw === 'object') {
    const raw = service.raw as Record<string, any>;
    if (source.doh?.format === 'quantumultx') {
      if ((raw.options || []).length) return;
    } else if (raw.type !== 'https' || Object.keys(raw).some(key => !['type', 'tag', 'server', 'server_port', 'path'].includes(key))) return;
  } else return;
  return service.url;
}

export function recordDomainDns(plan: GenerationPlan, ranges: NodeDomainRange[], method: string, applied: ReadonlyMap<NodeDomainRange, ReadonlySet<string>>): void {
  for (const binding of plan.bindings) {
    const relevant = ranges.filter(range => range.nodeIds.some(id => binding.nodeIds.includes(id)));
    if (!relevant.length) {
      if (binding.services.length && binding.nodeIds.length && binding.nodeIds.every(id => {
        const node = [...plan.ordinaryNodes, ...plan.dependencyNodes].find(node => node.id === id);
        return !!node && !!isIP(node.server.replace(/^\[|\]$/g, ''));
      })) { binding.status = 'ignored'; binding.method = 'ip-node-no-dns'; }
      continue;
    }
    const adopted = relevant.flatMap(range => range.services.filter(({ service }) => applied.get(range)?.has(service.id)));
    const adoptedKeys = new Set(adopted.map(dohServiceKey));
    const source = plan.inventory.sources.find(source => source.id === binding.sourceId)!;
    binding.appliedServiceIds = [...new Set([...adopted.map(({ service }) => service.id), ...binding.services.filter(service => adoptedKeys.has(dohServiceKey({ source, service }))).map(service => service.id)])];
    binding.status = adopted.length ? relevant.every(range => range.services.every(({ service }) => applied.get(range)?.has(service.id))) ? 'applied' : 'degraded' : 'unapplied';
    binding.method = adopted.length ? method : 'template-dns';
    binding.effectiveServices = [...new Map(adopted.map(({ source, service }) => [service.id, { sourceId: source.id, serviceId: service.id, url: service.url }])).values()];
    binding.domainRanges = relevant.filter(range => range.services.some(({ service }) => applied.get(range)?.has(service.id))).map(rangePattern);
  }
}
