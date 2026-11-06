import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import type { SourceDohResult, SourceDohService, SourceFormat, SubscriptionSource } from '../../types';

const mihomoLists = new Set(['nameserver', 'fallback', 'default-nameserver', 'proxy-server-nameserver', 'direct-nameserver']);
const mihomoPolicies = new Set(['nameserver-policy', 'proxy-server-nameserver-policy']);

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
    if (!match) return;
    const values = splitQuanxValues(match[1]);
    const optionIndex = values.findIndex(value => /^(?:included_ssids|excluded_ssids)\s*=/i.test(value));
    const options = optionIndex < 0 ? [] : values.slice(optionIndex);
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
  if (!/^https:\/\/[^/?#]+/i.test(value) || /\\|\s|[\u0000-\u001f\u007f]/.test(value)) throw new Error('DoH HTTPS 地址无效');
  const url = new URL(value);
  if (url.protocol !== 'https:' || !url.hostname) throw new Error('DoH HTTPS 地址无效');
  return url;
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
      if (!server || typeof server !== 'object') return;
      const typed = typeof server.type === 'string' && server.type.toLowerCase() === 'https';
      const legacy = typeof server.address === 'string' && /^https:/i.test(server.address);
      if (!typed && !legacy) return;
      let url: URL;
      if (typed) {
        const host = server.server;
        const port = server.server_port ?? 443;
        const path = server.path ?? '/dns-query';
        if (typeof host !== 'string' || !host || /[\s\\/?#@]/.test(host) || (host.includes(':') && !isIP(host.replace(/^\[|\]$/g, ''))) || !Number.isInteger(port) || port < 1 || port > 65535 || typeof path !== 'string' || !path.startsWith('/')) throw new Error('sing-box DoH 配置不完整');
        const authority = isIP(host) === 6 ? `[${host}]` : host;
        url = endpoint(`https://${authority}:${port}${path}`);
      } else url = endpoint(server.address);
      if (server.detour !== undefined && typeof server.detour !== 'string') throw new Error('sing-box DoH 出站无效');
      services.push({ id: randomUUID(), path: `dns.servers[${index}]`, url: url.href, raw: server, ...(server.detour ? { outbound: { kind: 'unresolved', name: server.detour } } : typed ? { outbound: { kind: 'direct' } } : {}) });
    });
    return services;
  }
  if (format !== 'mihomo') return services;
  const collect = (value: unknown, path: string) => {
    if (Array.isArray(value)) { value.forEach((item, index) => collect(item, `${path}[${index}]`)); return; }
    if (typeof value !== 'string' || !/^https:/i.test(value)) return;
    const url = endpoint(value);
    const suffix = url.hash.slice(1).split('&').find(part => part && !part.includes('='));
    url.hash = '';
    services.push({ id: randomUUID(), path, url: url.href, raw: value, ...(suffix ? { outbound: suffix.toUpperCase() === 'DIRECT' ? { kind: 'direct' as const, name: suffix } : { kind: suffix.toUpperCase() === 'RULES' ? 'routing' as const : 'unresolved' as const, name: suffix } } : {}) });
  };
  for (const [key, value] of Object.entries(document.dns)) {
    if (mihomoLists.has(key)) collect(value, `dns.${key}`);
    else if (mihomoPolicies.has(key) && value && typeof value === 'object') {
      for (const [policy, targets] of Object.entries(value)) collect(targets, `dns.${key}[${JSON.stringify(policy)}]`);
    }
  }
  return services;
}

export function sourceDohResult(sourceId: string, format: SourceFormat, updatedAt: string, services: SourceDohService[]): SourceDohResult {
  return { sourceId, batchId: randomUUID(), updatedAt, format, services, outbounds: [] };
}

/** Called after source nodes have received their durable identities. */
export function bindSourceDoh(_source: SubscriptionSource): void {}
