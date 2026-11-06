import { randomUUID } from 'node:crypto';
import { mihomoDnsFragment } from '../mihomo-dns';
import { isIP } from 'node:net';
import type { SourceDohOutbound, SourceDohReference, SourceDohResult, SourceDohService, SourceFormat, SubscriptionSource } from '../../types';

const mihomoLists = new Set(['nameserver', 'fallback', 'default-nameserver', 'proxy-server-nameserver', 'direct-nameserver']);
const mihomoPolicies = new Set(['nameserver-policy', 'proxy-server-nameserver-policy']);
const looksLikeHttps = (value: string) => /^https(?:[:/]|$)/i.test(value);

function splitQuanxValues(value: string): string[] {
  const values: string[] = [];
  let quote = '';
  let current = '';
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (character === '\\' && quote && index + 1 < value.length) { current += character + value[++index]; continue; }
    if (quote) { if (character === quote) quote = ''; }
    else if (character === '"' || character === "'") quote = character;
    else if (character === ',') { values.push(current.trim()); current = ''; continue; }
    current += character;
  }
  if (quote) throw new Error('QuanX DoH 配置不完整');
  values.push(current.trim());
  return values;
}

function extractQuanxDoh(content: string): SourceDohService[] {
  const services: SourceDohService[] = [];
  let section = '';
  content.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();
    const header = /^\[\s*([\w-]+)\s*\]/.exec(trimmed);
    if (header) { section = header[1].toLowerCase(); return; }
    if (section !== 'dns' || /^(#|;|\/\/)/.test(trimmed)) return;
    const match = /^doh-server\s*=\s*(.*)$/i.exec(trimmed);
    if (!match) {
      if (/^doh-server(?:\s|$)/i.test(trimmed)) throw new Error('QuanX DoH 配置不完整');
      return;
    }
    const values = splitQuanxValues(match[1]);
    const optionIndex = values.findIndex(value => /^(?:included_ssids|excluded_ssids)\s*=/i.test(value));
    const options = optionIndex < 0 ? [] : values.slice(optionIndex);
    for (const option of options) {
      const assignment = /^(?:included_ssids|excluded_ssids)\s*=\s*(.+)$/i.exec(option);
      if (!option || (!assignment && (option.includes('=') || /https[:/]/i.test(option)))) throw new Error('QuanX DoH SSID 配置无效');
    }
    const targets = optionIndex < 0 ? values : values.slice(0, optionIndex);
    if (!targets.length) throw new Error('QuanX DoH 配置不完整');
    targets.forEach((value, valueIndex) => {
      const position = value.toLowerCase().indexOf('https:');
      const scope = position > 0 ? value.slice(0, position) : undefined;
      if (scope && (!scope.startsWith('/') || !scope.endsWith('/'))) throw new Error('QuanX DoH 域名范围无效');
      const url = endpoint(position < 0 ? value : value.slice(position));
      services.push({ id: randomUUID(), path: `dns.line[${index + 1}].doh-server[${valueIndex}]`, url: url.href, raw: { line, value, ...(scope ? { scope } : {}), options } });
    });
  });
  return services;
}

function endpoint(value: string): URL {
  if (!/^https:\/\/[^/?#]+/i.test(value) || /\\|\s|[\u0000-\u001f\u007f]|%(?![\da-f]{2})/i.test(value)) throw new Error('DoH HTTPS 地址无效');
  const url = new URL(value);
  if (url.protocol !== 'https:' || !url.hostname) throw new Error('DoH HTTPS 地址无效');
  return url;
}

function validateSingboxConnection(server: Record<string, unknown>): void {
  const fail = () => { throw new Error('sing-box DoH 连接配置不完整'); };
  const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
  for (const key of ['detour', 'address_resolver', 'address_strategy', 'strategy', 'domain_strategy', 'connect_timeout']) {
    if (server[key] !== undefined && typeof server[key] !== 'string') fail();
  }
  if (server.domain_resolver !== undefined && typeof server.domain_resolver !== 'string' && (!object(server.domain_resolver) || typeof server.domain_resolver.server !== 'string' || !server.domain_resolver.server)) fail();
  if (object(server.domain_resolver) && server.domain_resolver.strategy !== undefined && typeof server.domain_resolver.strategy !== 'string') fail();
  if (server.tls !== undefined) {
    if (!object(server.tls)) fail();
    else {
      for (const key of ['enabled', 'insecure', 'disable_sni']) if (server.tls[key] !== undefined && typeof server.tls[key] !== 'boolean') fail();
      if (server.tls.server_name !== undefined && typeof server.tls.server_name !== 'string') fail();
      if (server.tls.alpn !== undefined && (!Array.isArray(server.tls.alpn) || server.tls.alpn.some(value => typeof value !== 'string'))) fail();
      if (server.tls.certificate !== undefined && typeof server.tls.certificate !== 'string' && (!Array.isArray(server.tls.certificate) || server.tls.certificate.some(value => typeof value !== 'string'))) fail();
    }
  }
  if (server.headers !== undefined && (!object(server.headers) || Object.values(server.headers).some(value => typeof value !== 'string' && (!Array.isArray(value) || value.some(item => typeof item !== 'string'))))) fail();
}

/** Source-owned services are staged before the successful response is published. */
export function extractSourceDoh(format: SourceFormat, document?: Record<string, unknown>, content?: string): SourceDohService[] {
  const services: SourceDohService[] = [];
  if (format === 'quantumultx') return extractQuanxDoh(content || '');
  if (!document?.dns || typeof document.dns !== 'object') return services;
  if (format === 'singbox') {
    const servers = (document.dns as Record<string, unknown>).servers;
    if (!Array.isArray(servers)) return services;
    servers.forEach((server, index) => {
      if (typeof server === 'string' && looksLikeHttps(server)) throw new Error('sing-box DoH 配置不完整');
      if (!server || typeof server !== 'object') return;
      const typed = typeof server.type === 'string' && server.type.toLowerCase() === 'https';
      const legacy = typeof server.address === 'string' && looksLikeHttps(server.address);
      if (!typed && !legacy) return;
      validateSingboxConnection(server);
      let url: URL;
      if (typed) {
        const host = server.server;
        const port = server.server_port ?? 443;
        const path = server.path ?? '/dns-query';
        if (typeof host !== 'string' || !host || /[\s\\/?#@]/.test(host) || (host.includes(':') && !isIP(host.replace(/^\[|\]$/g, ''))) || !Number.isInteger(port) || port < 1 || port > 65535 || typeof path !== 'string' || !path.startsWith('/')) throw new Error('sing-box DoH 配置不完整');
        const authority = isIP(host) === 6 ? `[${host}]` : host;
        url = endpoint(`https://${authority}:${port}${path}`);
      } else url = endpoint(server.address);
      services.push({ id: randomUUID(), path: `dns.servers[${index}]`, url: url.href, raw: server, ...(server.detour ? { outbound: { kind: 'unresolved', name: server.detour } } : typed ? { outbound: { kind: 'direct' } } : {}) });
    });
    return services;
  }
  if (format !== 'mihomo') return services;
  const collect = (value: unknown, path: string) => {
    if (Array.isArray(value)) { value.forEach((item, index) => collect(item, `${path}[${index}]`)); return; }
    if (typeof value !== 'string' || !looksLikeHttps(value)) return;
    const hash = value.indexOf('#');
    const url = endpoint(hash < 0 ? value : value.slice(0, hash));
    const suffix = mihomoDnsFragment(value).route;
    services.push({ id: randomUUID(), path, url: url.href, raw: value, outbound: suffix ? suffix === 'DIRECT' ? { kind: 'direct' as const, name: suffix } : { kind: suffix === 'RULES' ? 'routing' as const : 'unresolved' as const, name: suffix } : defaultMihomoDohEgress(path, document) });
  };
  for (const [key, value] of Object.entries(document.dns)) {
    if (mihomoLists.has(key)) collect(value, `dns.${key}`);
    else if (mihomoPolicies.has(key) && value && typeof value === 'object') {
      for (const [policy, targets] of Object.entries(value)) collect(targets, `dns.${key}[${JSON.stringify(policy)}]`);
    }
  }
  return services;
}

/** Mihomo v1.19.33 config.go parseNameServer: only normal/fallback/policy respect routing. */
export function defaultMihomoDohEgress(path: string, document: Record<string, any>): SourceDohReference {
  const respectsRules = /^dns\.(nameserver|fallback)(?:\[|$)|^dns\.nameserver-policy\[/.test(path) && document.dns?.['respect-rules'] === true;
  return { kind: respectsRules ? 'routing' : 'direct' };
}

export function sourceDohResult(sourceId: string, format: SourceFormat, updatedAt: string, services: SourceDohService[]): SourceDohResult {
  return { sourceId, batchId: randomUUID(), updatedAt, format, services, outbounds: [] };
}

/** Called after source nodes have received their durable identities. */
export function bindSourceDoh(source: SubscriptionSource): void {
  const doh = source.doh;
  if (!doh) return;
  const document = source.parsedConfig;
  const rawGroups = doh.format === 'mihomo' ? document?.['proxy-groups'] : doh.format === 'singbox' ? document?.outbounds : [];
  const groups: SourceDohOutbound[] = (Array.isArray(rawGroups) ? rawGroups : [])
    .filter(raw => raw && typeof raw === 'object' && (doh.format !== 'singbox' || ['selector', 'urltest', 'direct', 'block', 'dns'].includes(raw.type)))
    .map((raw, index) => ({ id: `${source.id}:${doh.batchId}:outbound:${index}`, name: String(raw.name ?? raw.tag ?? ''), raw, references: [] }));
  const nodes = [...(source.nodes || []), ...(source.infoNodes || [])];
  const neededGroups = new Set<string>();
  const visitedNodes = new Set<string>();
  const resolve = (name: string): SourceDohReference => {
    if (doh.format === 'mihomo' && name === 'DIRECT') return { kind: 'direct', name };
    const matchedNodes = nodes.filter(node => (node.originalName ?? node.name) === name);
    const matchedGroups = groups.filter(group => group.name === name);
    matchedGroups.forEach(group => neededGroups.add(group.id));
    matchedNodes.forEach(node => {
      if (visitedNodes.has(node.id)) return;
      visitedNodes.add(node.id);
      const next = node.raw && typeof node.raw === 'object' ? node.raw.detour ?? node.raw['dialer-proxy'] : undefined;
      if (typeof next === 'string') resolve(next);
    });
    if (matchedNodes.length + matchedGroups.length > 1) return { kind: 'ambiguous', name, candidates: [...matchedNodes.map(node => `node:${node.id}`), ...matchedGroups.map(group => `outbound:${group.id}`)] };
    if (matchedNodes.length === 1) return { kind: 'source-node', name, nodeId: matchedNodes[0].id };
    if (matchedGroups.length === 1) return { kind: 'source-group', name, outboundId: matchedGroups[0].id };
    return { kind: 'unresolved', name };
  };
  // Node detours and bootstrap DNS transports share the same source-private namespace.
  for (const node of nodes) {
    const label = node.raw && typeof node.raw === 'object' ? node.raw.detour ?? node.raw['dialer-proxy'] : undefined;
    if (typeof label === 'string') resolve(label);
  }
  const servers = (document?.dns as Record<string, any> | undefined)?.servers;
  if (Array.isArray(servers)) for (const server of servers) if (typeof server?.detour === 'string') resolve(server.detour);
  for (const service of doh.services) {
    if (service.outbound?.name && !['direct', 'routing'].includes(service.outbound.kind)) service.outbound = resolve(service.outbound.name);
  }
  const visitedGroups = new Set<string>();
  for (const id of neededGroups) {
    if (visitedGroups.has(id)) continue;
    visitedGroups.add(id);
    const group = groups.find(candidate => candidate.id === id)!;
    const members = group.raw.proxies ?? group.raw.outbounds;
    if (Array.isArray(members)) group.references = members.filter((name): name is string => typeof name === 'string').map(resolve);
    const detour = group.raw.detour ?? group.raw['dialer-proxy'];
    if (typeof detour === 'string') group.references.push(resolve(detour));
  }
  doh.outbounds = groups.filter(group => neededGroups.has(group.id));
}
