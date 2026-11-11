import { randomUUID } from 'node:crypto';
import { nodeInputFields } from './node-naming';
import type { CountryPatternRule, ProxyNode, SubscriptionSource } from '../types';

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sorted(v)]));
  return value;
}
function decode64(value: string): string { return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); }
function rawConnection(node: ProxyNode): unknown {
  if (node.raw && typeof node.raw === 'object') {
    const raw = { ...node.raw };
    if ('server_port' in raw || ['shadowsocks', 'socks', 'http'].includes(raw.type) && 'tag' in raw) delete raw.tag;
    else delete raw.name;
    return raw;
  }
  if (typeof node.raw === 'string') {
    const raw = node.raw.trim();
    if (/^(vmess|v2rayn):\/\//i.test(raw)) {
      try {
        const value = JSON.parse(decode64(raw.slice(raw.indexOf('://') + 3).split('#')[0]));
        delete value.ps; delete value.Remarks; delete value.remarks;
        return { scheme: raw.slice(0, raw.indexOf(':')).toLowerCase(), value };
      } catch { /* Some VMess links use ordinary URI form. */ }
    }
    if (raw.includes('://')) {
      try {
        const url = new URL(raw);
        const query: Record<string, string[]> = {};
        for (const [key, value] of url.searchParams) (query[key] ||= []).push(value);
        return { scheme: url.protocol, username: url.username, password: url.password, host: url.hostname, port: url.port, path: url.pathname, query };
      } catch { return raw.split('#')[0]; }
    }
    // QuanX fields may contain quoted/escaped commas. Preserve repeated options.
    const fields = raw.match(/(?:[^,"'\\]|\\.|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')+/g) || [raw];
    const options: Record<string, string[]> = {};
    for (const field of fields) {
      const equal = field.indexOf('=');
      const key = field.slice(0, equal).trim().toLowerCase();
      if (key === 'tag') continue;
      (options[key] ||= []).push(field.slice(equal + 1).trim());
    }
    return options;
  }
  const { id, name, originalName, localName, enabled, sourceId, sourceName, countryCode, countryEmoji, detourRef, ...connection } = node;
  return connection;
}

/** Compare all upstream connection data, keeping nested fields and explicit defaults intact. */
export function connectionFingerprint(node: ProxyNode, peers: ProxyNode[] = [], stack = new Set<ProxyNode>()): string {
  const connection = rawConnection(node) as any;
  if (connection && typeof connection === 'object' && !Array.isArray(connection)) {
    for (const key of ['detour', 'dialer-proxy']) {
      const label = connection[key];
      if (typeof label !== 'string') continue;
      const matches = peers.filter(peer => (peer.originalName ?? peer.name) === label);
      if (matches.length === 1) {
        const target = matches[0];
        connection[key] = stack.has(target) ? { cycle: rawConnection({ ...target, raw: { ...target.raw, detour: undefined, 'dialer-proxy': undefined } }) } : { connection: connectionFingerprint(target, peers, new Set([...stack, node])) };
      }
    }
  }
  return JSON.stringify(sorted(connection));
}

/** Apply a complete result against the latest saved local settings, scoped to one source. */
export function prepareSourceNodes(candidate: SubscriptionSource, previous?: SubscriptionSource, countryRules?: CountryPatternRule[]): void {
  const incoming = [...(candidate.nodes || []), ...(candidate.infoNodes || [])];
  const old = previous?.id === candidate.id ? [...(previous.nodes || []), ...(previous.infoNodes || [])] : [];
  const oldByKey = new Map<string, ProxyNode[]>();
  const newByKey = new Map<string, ProxyNode[]>();
  for (const node of old) { const key = connectionFingerprint(node, old); oldByKey.set(key, [...(oldByKey.get(key) || []), node]); }
  for (const node of incoming) { const key = connectionFingerprint(node, incoming); newByKey.set(key, [...(newByKey.get(key) || []), node]); }
  for (const node of incoming) {
    const key = connectionFingerprint(node, incoming);
    const matches = oldByKey.get(key);
    const matched = matches?.length === 1 && newByKey.get(key)?.length === 1 ? matches[0] : undefined;
    node.originalName = node.originalName ?? node.name;
    node.id = matched?.id || `node-${randomUUID()}`;
    node.localName = matched?.localName;
    node.enabled = matched?.enabled !== false;
    if (node.localName) Object.assign(node, nodeInputFields(node, countryRules));
    node.sourceId = candidate.id;
    node.sourceName = candidate.name;
  }
  for (const node of incoming) {
    const label = node.raw && typeof node.raw === 'object' ? node.raw.detour ?? node.raw['dialer-proxy'] : node.detour;
    if (typeof label !== 'string') continue;
    const matches = incoming.filter(target => target.originalName === label);
    node.detourRef = matches.length === 1 ? `node:${matches[0].id}` : `${matches.length ? 'ambiguous' : 'unresolved'}:${label}`;
  }
}
