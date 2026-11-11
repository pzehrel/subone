import yaml from 'js-yaml';
import type { ProxyNode, UnifiedRuleItem, SubscriptionSource } from '../../types/index';
import { cleanSourceOrGroupName, formatCidr, formatSourceGroupTag } from './common';
import { egernRuleSource } from './egern-ruleset';
import { resolveGroupNodes, type OutputGroup } from './group-nodes';

export class EgernConfigError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = 'EgernConfigError'; }
}
const fail = (code: string, message: string): never => { throw new EgernConfigError(code, message); };
type NativeEntry = Record<string, any>;
export const egernEntry = (entry: NativeEntry): NativeEntry => Object.values(entry)[0] as NativeEntry;

/** Egern 2.21 uses a typed mapping, never a Mihomo proxy object. */
export function nodeToEgernProxy(node: ProxyNode): NativeEntry {
  const value: NativeEntry = { name: node.name, server: node.server.trim().replace(/^\[(.*)\]$/, '$1'), port: node.port };
  const unsupported = (detail: string): never => fail('egern-node-options-unsupported', `Egern 节点「${node.name}」无法无损转换 ${detail}`);
  const raw = node.raw && typeof node.raw === 'object' ? node.raw : {};
  if (node.detour) value.prev_hop = node.detour;
  if (raw.tfo !== undefined || raw.tcp_fast_open !== undefined) value.tfo = raw.tfo ?? raw.tcp_fast_open;
  if (node.fingerprint || node.certificate || node.certificatePublicKeySha256?.length) unsupported('TLS 指纹/证书选项');
  if (node.multiplex || raw.smux?.enabled || raw.multiplex?.enabled) unsupported('multiplex');
  if (node.maxEarlyData || node.earlyDataHeaderName) unsupported('WebSocket early data');
  if (node.packetEncoding) unsupported('packetEncoding');
  if (node.alpn?.length && node.type !== 'tuic' && !(node.network === 'grpc' && node.alpn.length === 1 && node.alpn[0] === 'h2')) unsupported('ALPN');
  if (node.network && node.network !== 'tcp' && !['vmess', 'vless', 'trojan'].includes(node.type)) unsupported(`transport ${node.network}`);
  if (node.reality?.enabled && !['vmess', 'vless', 'trojan', 'anytls'].includes(node.type)) unsupported('REALITY');
  if (node.udp !== undefined && ['ss', 'socks5', 'vmess', 'vless', 'trojan', 'snell', 'anytls'].includes(node.type)) value.udp_relay = node.udp;
  const tls = (): NativeEntry => ({ ...(node.sni ? { sni: node.sni } : {}), ...(node.reality?.enabled
    ? { reality: { public_key: node.reality.publicKey, ...(node.reality.shortId ? { short_id: node.reality.shortId } : {}) } }
    : { skip_tls_verify: node.skipCertVerify ?? false }) });
  const transport = (): NativeEntry | undefined => {
    switch (node.network || 'tcp') {
      case 'tcp': return node.tls || node.reality?.enabled ? { tls: tls() } : undefined;
      case 'ws':
        if (node.reality?.enabled) return unsupported('WebSocket REALITY');
        return { [node.tls ? 'wss' : 'ws']: { path: node.wsPath || '/', ...(node.wsHeaders ? { headers: node.wsHeaders } : {}), ...(node.tls ? tls() : {}) } };
      case 'grpc':
        if (!node.tls && !node.reality?.enabled) return unsupported('明文 gRPC');
        return { grpc: { ...(node.grpcServiceName ? { service_name: node.grpcServiceName } : {}), ...tls() } };
      case 'http':
        if (node.tls || node.reality?.enabled) return unsupported('HTTP/1 TLS transport');
        return { http1: { path: node.wsPath || '/' } };
      case 'h2': {
        if (!node.tls || node.reality?.enabled) return unsupported('HTTP/2 非 TLS / REALITY transport');
        const hosts = raw['h2-opts']?.host;
        if (Array.isArray(hosts) && hosts.length > 1) return unsupported('HTTP/2 多 Host');
        const host = node.h2Host || (Array.isArray(hosts) ? hosts[0] : hosts);
        return { http2: { path: node.h2Path || node.wsPath || '/', ...(host ? { headers: { Host: host } } : {}), ...tls() } };
      }
      default: return unsupported(`transport ${node.network}`);
    }
  };
  const portHopping = () => {
    if (node.serverPorts?.length) value.port_hopping = node.serverPorts.join(',');
    if (node.hopInterval) {
      if (!/^\d+s?$/.test(node.hopInterval)) unsupported('port hopping interval');
      value.port_hopping_interval = Number(node.hopInterval.replace(/s$/, ''));
    }
  };
  switch (node.type) {
    case 'ss':
      value.method = node.method || node.cipher;
      value.password = node.password;
      if (node.plugin || raw.plugin) {
        const plugin = node.plugin || raw.plugin;
        if (!['obfs-local', 'simple-obfs'].includes(plugin)) unsupported(`插件 ${plugin}`);
        const opts = node.pluginOpts || raw['plugin-opts'] || {};
        if (!['http', 'tls'].includes(opts.mode) || Object.keys(opts).some(key => !['mode', 'host', 'uri'].includes(key))) unsupported('Shadowsocks obfs 插件参数');
        value.obfs = opts.mode;
        if (opts.host) value.obfs_host = opts.host;
        if (opts.uri) value.obfs_uri = opts.uri;
      }
      return { shadowsocks: value };
    case 'socks5':
    case 'http':
      if (node.username !== undefined) value.username = node.username;
      if (node.password !== undefined) value.password = node.password;
      if (node.tls) Object.assign(value, tls());
      if (node.type === 'http' && raw.headers) value.headers = structuredClone(raw.headers);
      return { [node.type === 'http' ? node.tls ? 'https' : 'http' : node.tls ? 'socks5_tls' : 'socks5']: value };
    case 'vmess':
    case 'vless': {
      if (node.alterId) unsupported('VMess alterId');
      value.user_id = node.uuid;
      if (node.type === 'vmess') value.security = node.cipher || node.method || 'auto';
      if (node.flow) {
        if (node.type !== 'vless' || node.flow !== 'xtls-rprx-vision') unsupported(`flow ${node.flow}`);
        value.flow = node.flow;
      }
      const nativeTransport = transport();
      if (nativeTransport) value.transport = nativeTransport;
      return { [node.type]: value };
    }
    case 'trojan':
    case 'anytls':
      value.password = node.password;
      Object.assign(value, tls());
      if (node.type === 'anytls' && (node.idleSessionTimeout || node.idleSessionCheckInterval || node.minIdleSession)) unsupported('AnyTLS session options');
      if (node.network && node.network !== 'tcp') {
        if (node.type !== 'trojan' || node.network !== 'ws') unsupported(`transport ${node.network}`);
        if (node.wsHeaders && Object.keys(node.wsHeaders).some(key => key.toLowerCase() !== 'host')) unsupported('Trojan WebSocket headers');
        const host = Object.entries(node.wsHeaders || {}).find(([key]) => key.toLowerCase() === 'host')?.[1];
        value.websocket = { path: node.wsPath || '/', ...(host ? { host } : {}) };
      }
      return { [node.type]: value };
    case 'snell':
      value.psk = node.psk || node.password;
      if (node.snellVersion !== undefined) value.version = node.snellVersion;
      if (node.obfs) {
        if (!['http', 'tls'].includes(node.obfs)) unsupported('Snell obfs');
        value.obfs = node.obfs;
        if (node.obfsHost) value.obfs_host = node.obfsHost;
      }
      return { snell: value };
    case 'hysteria2':
      value.auth = node.password;
      Object.assign(value, tls());
      if (node.obfs) {
        if (node.obfs !== 'salamander') unsupported('Hysteria2 obfs');
        value.obfs = node.obfs;
        if (node.obfsPassword) value.obfs_password = node.obfsPassword;
      }
      if (node.downMbps !== undefined) unsupported('Hysteria2 download bandwidth');
      if (node.upMbps !== undefined) value.bandwidth = node.upMbps;
      portHopping();
      return { hysteria2: value };
    case 'tuic':
      if (node.zeroRttHandshake !== undefined || node.heartbeat || node.quicCongestionControl || node.congestionControl) unsupported('TUIC handshake / congestion options');
      value.uuid = node.uuid; value.password = node.password;
      Object.assign(value, tls());
      if (node.udpRelayMode) value.udp_relay_mode = node.udpRelayMode;
      if (node.alpn) value.alpn = [...node.alpn];
      portHopping();
      return { tuic: value };
    case 'wireguard': {
      value.private_key = node.privateKey; value.peer_public_key = node.publicKey;
      if (node.presharedKey) value.preshared_key = node.presharedKey;
      const addresses = node.localAddress || [node.ip, node.ipv6].filter((address): address is string => !!address);
      const v4 = addresses.filter(address => !address.includes(':')); const v6 = addresses.filter(address => address.includes(':'));
      if (!addresses.length || v4.length > 1 || v6.length > 1 || node.remoteDnsResolve) unsupported('WireGuard address / remote DNS options');
      if (v4[0]) value.local_ipv4 = v4[0];
      if (v6[0]) value.local_ipv6 = v6[0];
      if (node.reserved) value.reserved = [...node.reserved];
      if (node.mtu !== undefined) value.mtu = node.mtu;
      return { wireguard: value };
    }
    default: return fail('egern-protocol-unsupported', `Egern 尚不支持转换节点「${node.name}」的 ${node.type} 协议`);
  }
}

export interface EgernGeneratorOptions {
  expandNodes?: boolean;
  baseUrl?: string;
  subToken?: string;
  ordinaryNodeIds?: ReadonlySet<string>;
  dependencyGroupIds?: ReadonlySet<string>;
  ordinaryGroupIds?: ReadonlySet<string>;
  inventorySources?: SubscriptionSource[];
}
function parseTemplate(text: string): NativeEntry {
  let document: any;
  try { document = text.trim() ? yaml.load(text) ?? {} : {}; } catch { return fail('egern-template-invalid', 'Egern 模板 YAML 无法解析'); }
  if (typeof document !== 'object' || Array.isArray(document)) return fail('egern-template-invalid', 'Egern 模板必须是原生配置对象');
  if ('proxy-groups' in document || 'sources' in document || document.dns?.nameservers) return fail('egern-template-schema-unsupported', 'Egern 模板须使用原生 policy_groups、typed proxies/rules 和 dns.bootstrap/upstreams');
  for (const key of ['proxies', 'policy_groups', 'rules']) {
    if (document[key] === undefined) document[key] = [];
    if (!Array.isArray(document[key]) || document[key].some((entry: any) => !entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).length !== 1 || typeof egernEntry(entry) !== 'object')) return fail('egern-template-schema-unsupported', `Egern 模板 ${key} 须使用原生类型对象`);
  }
  return document;
}

export function generateEgernDocument(templateYaml: string, nodes: ProxyNode[], proxyGroups: OutputGroup[] = [], rulesList: UnifiedRuleItem[] = [], sources: SubscriptionSource[] = [], options?: EgernGeneratorOptions): NativeEntry {
  return injectUnifiedToEgern(parseTemplate(templateYaml), nodes.map(nodeToEgernProxy), nodes, proxyGroups, rulesList, sources, options);
}
export function generateEgernConfig(templateYaml: string, nodes: ProxyNode[], proxyGroups: OutputGroup[] = [], rulesList: UnifiedRuleItem[] = [], sources: SubscriptionSource[] = [], options?: EgernGeneratorOptions): string {
  return yaml.dump(generateEgernDocument(templateYaml, nodes, proxyGroups, rulesList, sources, options), { indent: 2, lineWidth: -1, noRefs: true });
}

export function injectUnifiedToEgern(doc: NativeEntry, egernProxies: NativeEntry[], nodes: ProxyNode[], proxyGroups: OutputGroup[], rulesList: UnifiedRuleItem[], sources: SubscriptionSource[] = [], options?: EgernGeneratorOptions): NativeEntry {
  const ordinary = nodes.filter(node => !options?.ordinaryNodeIds || options.ordinaryNodeIds.has(node.id));
  doc.proxies = [...(doc.proxies || []), ...egernProxies];
  const groups = proxyGroups.map(group => ({ ...group }));
  const used = new Set(['DIRECT', 'REJECT', ...doc.proxies.map((entry: NativeEntry) => egernEntry(entry).name), ...(doc.policy_groups || []).map((entry: NativeEntry) => egernEntry(entry).name), ...groups.map(group => group.name)]);
  for (const source of sources.filter(source => !options?.ordinaryNodeIds && source.enabled && ordinary.some(node => node.sourceId === source.id))) {
    const clean = cleanSourceOrGroupName(source.name).toLowerCase();
    if (groups.some(group => cleanSourceOrGroupName(group.name).toLowerCase() === clean || group.id === `grp-src-${source.id}`)) continue;
    const base = formatSourceGroupTag(source); let name = base; let suffix = 2;
    while (used.has(name)) name = `${base} (${suffix++})`;
    used.add(name);
    groups.push({ id: `grp-src-${source.id}`, name, type: 'urltest', sources: [source.id], interval: 300, tolerance: 50, url: 'https://www.google.com/generate_204' });
  }
  const generated = groups.map(group => {
    if (!['select', 'urltest', 'fallback', 'load-balance', 'relay', 'direct', 'reject'].includes(group.type)) return fail('egern-group-unsupported', `Egern 不支持策略组「${group.name}」的 ${group.type} 类型`);
    if (group.type === 'relay') return fail('egern-group-unsupported', `Egern 不支持原生 Relay 策略组「${group.name}」；无法无损转换有序链`);
    if (group.lazy !== undefined || group.strategy && !(group.type === 'load-balance' && group.strategy === 'round-robin')) return fail('egern-group-options-unsupported', `Egern 策略组「${group.name}」无法无损转换 lazy/strategy`);
    const type = ({ urltest: 'auto_test', 'load-balance': 'load_balance', direct: 'select', reject: 'select' } as Record<string, string>)[group.type] || group.type;
    const value: NativeEntry = { name: group.name };
    const candidates = options?.dependencyGroupIds?.has(group.id) && !options.ordinaryGroupIds?.has(group.id) ? nodes : ordinary;
    const groupSources = options?.dependencyGroupIds?.has(group.id) ? options.inventorySources || sources : sources;
    if (group.type === 'direct' || group.type === 'reject') value.policies = [group.type === 'direct' ? 'DIRECT' : 'REJECT'];
    else if (group.membersResolved) value.policies = group.proxies!.map(name => name === '🎯 本地直连' ? 'DIRECT' : name);
    else {
      const mounted = (group.sources ?? group.use)?.length || group.filter || group.includeAll || ['♻️ 自动选择', '👉 手动选择'].includes(group.name);
      const members = [...(group.proxies || []), ...(mounted || !group.proxies?.length ? resolveGroupNodes(group, candidates, groupSources).map(node => node.name) : [])];
      value.policies = [...new Set(members.map(name => name === '🎯 本地直连' ? 'DIRECT' : name))];
      // Serve the selected plan through SubOne; raw upstream URLs bypass local exclusions.
      if (!options?.dependencyGroupIds?.has(group.id) && !options?.expandNodes && options?.baseUrl && options?.subToken && (mounted || !group.proxies?.length)) {
        const selected = new Set(resolveGroupNodes(group, candidates, groupSources).map(node => node.sourceId));
        value.urls = sources.filter(source => source.enabled && selected.has(source.id)).map(source => `${options.baseUrl!.replace(/\/+$/, '')}/s/${encodeURIComponent(options.subToken!)}/source/${encodeURIComponent(source.id)}?target=egern`);
        if (!value.urls.length) delete value.urls;
        if (group.filter && value.urls) value.filter = group.filter;
      }
      if (!value.policies.length) {
        if (options?.dependencyGroupIds?.has(group.id) || group.proxies?.length) return fail('egern-group-empty', `Egern 策略组「${group.name}」没有可用成员`);
        value.policies = ['DIRECT'];
      }
    }
    if (group.type === 'load-balance' && group.strategy === 'round-robin') value.algorithm = 'round_robin';
    if (group.icon) value.icon = group.icon;
    if (group.hidden !== undefined) value.hidden = group.hidden;
    if (group.url) value.latency_test_url = group.url;
    if (['auto_test', 'fallback', 'load_balance'].includes(type) && group.interval !== undefined) value.interval = group.interval;
    if (type === 'auto_test' && group.tolerance !== undefined) value.tolerance = group.tolerance;
    return { [type]: value };
  });
  doc.policy_groups = [...(doc.policy_groups || []), ...generated];
  const nativeRuleTypes: Record<string, string> = { DOMAIN: 'domain', 'DOMAIN-SUFFIX': 'domain_suffix', 'DOMAIN-KEYWORD': 'domain_keyword', 'IP-CIDR': 'ip_cidr', 'IP-CIDR6': 'ip_cidr6', GEOIP: 'geoip', FINAL: 'default' };
  const additions = rulesList.filter(rule => rule.enabled).flatMap<NativeEntry>(rule => {
    if (rule.kind === 'remote') {
      const converted = egernRuleSource(rule);
      const url = converted ? options?.baseUrl && options?.subToken ? `${options.baseUrl.replace(/\/+$/, '')}/s/${encodeURIComponent(options.subToken)}/rules/${encodeURIComponent(rule.id)}/egern` : undefined : rule.clientUrls?.egern;
      if (!url) return fail('egern-ruleset-unsupported', `Egern 规则「${rule.name}」需要 Egern 原生规则地址或已支持的文本/JSON 来源`);
      return { rule_set: { match: url, policy: rule.outbound, update_interval: 86400 } };
    }
    const type = nativeRuleTypes[rule.type];
    if (!type) return fail('egern-rule-unsupported', `Egern 尚不支持转换 ${rule.type} 规则「${rule.name}」`);
    if (type === 'default') return { default: { policy: rule.outbound } };
    const cidr = type === 'ip_cidr' || type === 'ip_cidr6';
    return rule.payload.split(/[,;\n]+/).map(payload => payload.trim()).filter(Boolean).map(payload => {
      const actualType = cidr && payload.includes(':') ? 'ip_cidr6' : type;
      return { [actualType]: { match: cidr ? formatCidr(payload) : payload, policy: rule.outbound } };
    });
  });
  const retained = (doc.rules || []) as NativeEntry[];
  const firstDefault = retained.findIndex(rule => 'default' in rule);
  doc.rules = firstDefault >= 0 ? [...retained.slice(0, firstDefault), ...additions, ...retained.slice(firstDefault)] : [...retained, ...additions];
  if (!doc.rules.some((rule: NativeEntry) => 'default' in rule)) doc.rules.push({ default: { policy: 'DIRECT' } });
  validateEgernReferences(doc);
  return doc;
}

/** Static reference checks are not real Egern loading. */
export function validateEgernReferences(doc: NativeEntry): void {
  const definitions: NativeEntry[] = [...(doc.proxies || []), ...(doc.policy_groups || [])].map(egernEntry);
  const names = new Set(['DIRECT', 'REJECT']);
  for (const entry of definitions) {
    if (typeof entry.name !== 'string' || names.has(entry.name)) return fail('egern-reference-duplicate', `Egern 出站名称缺失或重复：${entry.name || ''}`);
    names.add(entry.name);
  }
  const requireName = (name: unknown, owner: string) => {
    if (typeof name !== 'string' || !names.has(name)) fail('egern-reference-missing', `Egern「${owner}」缺少出站：${String(name)}`);
  };
  const references = (entry: NativeEntry): string[] => [
    ...(entry.policies || []), ...(entry.prev_hop ? [entry.prev_hop] : []), ...(entry.default_policy ? [entry.default_policy] : []),
    ...(entry.rules || []).map(egernEntry).filter((rule: NativeEntry) => !rule.disabled && rule.policy).map((rule: NativeEntry) => rule.policy),
  ];
  for (const entry of definitions) for (const name of references(entry)) requireName(name, entry.name);
  for (const key of ['default_proxy_group', 'default_subscription_group']) if (doc[key]) requireName(doc[key], key);
  for (const entry of (doc.rules || []).map(egernEntry)) if (!entry.disabled) requireName(entry.policy, 'rule');
  const visited = new Set<string>();
  const visit = (name: string, path: string[]) => {
    if (path.includes(name)) return fail('egern-reference-cycle', `Egern 连接依赖循环：${[...path, name].join(' → ')}`);
    if (visited.has(name)) return;
    const entry = definitions.find(value => value.name === name);
    if (entry) for (const next of references(entry)) visit(next, [...path, name]);
    visited.add(name);
  };
  for (const entry of definitions) visit(entry.name, []);
}
