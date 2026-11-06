import yaml from 'js-yaml';
import { ProxyNode, ProxyGroupItem, UnifiedRuleItem, SubscriptionSource } from '../../types/index';

import { adaptRulesetForMihomo, formatRuleTag } from './ruleset-adapter';
import { resolveGroupNodes } from './group-nodes';
import { UnsupportedProxyGroupError } from './errors';
import { sourceSubscriptionUrl, resolveSafeOutbound, formatCidr, cleanSourceOrGroupName, formatSourceGroupTag } from './common';

export function nodeToMihomoProxy(node: ProxyNode): any {
  // Only reuse raw if it is legitimately a Clash/Mihomo proxy object (not sing-box outbound, etc.)
  if (
    node.raw &&
    typeof node.raw === 'object' &&
    node.raw.type &&
    node.raw.server &&
    (node.raw.port || node.raw.ports) &&
    !node.raw.server_port &&
    !node.raw.tag
  ) {
    const rawCopy: any = {
      ...node.raw,
      name: node.name,
    };
    if (typeof rawCopy.server === 'string') {
      rawCopy.server = rawCopy.server.trim().replace(/^\[(.*)\]$/, '$1');
    }
    // Fix legacy or misconfigured reality field in raw if present
    if (rawCopy.reality && !rawCopy['reality-opts']) {
      rawCopy['reality-opts'] = {
        'public-key': rawCopy.reality['public-key'] || rawCopy.reality.publicKey,
        'short-id': rawCopy.reality['short-id'] || rawCopy.reality.shortId || '',
      };
      delete rawCopy.reality;
    }
    if (rawCopy.udp === undefined) {
      rawCopy.udp = true;
    }
    return rawCopy;
  }

  const cleanServer = (node.server || '').trim().replace(/^\[(.*)\]$/, '$1');

  const base: any = {
    name: node.name,
    type: node.type === 'ss' ? 'ss' : node.type,
    server: cleanServer,
    port: node.port,
    udp: node.udp !== undefined ? Boolean(node.udp) : true,
  };

  if (node.type === 'ssr') {
    base.cipher = node.method;
    base.password = node.password;
    base.protocol = node.protocol;
    base['protocol-param'] = node.protocolParam;
    base.obfs = node.obfs;
    base['obfs-param'] = node.obfsParam;
    return base;
  }

  if (node.type === 'ss') {
    base.cipher = node.method || 'aes-128-gcm';
    base.password = node.password;
    if (node.packetEncoding) base['packet-encoding'] = node.packetEncoding;
    if (node.plugin) {
      base.plugin = node.plugin;
      base['plugin-opts'] = node.pluginOpts;
    }
    return base;
  }

  if (node.type === 'vless') {
    base.uuid = node.uuid;
    if (node.flow) base.flow = node.flow;
    base['packet-encoding'] = node.packetEncoding || 'xudp';
    if (node.tls || (node.reality && node.reality.enabled)) {
      base.tls = true;
      if (node.sni) base.servername = node.sni;
      if (node.fingerprint) base['client-fingerprint'] = node.fingerprint;
      if (node.skipCertVerify) base['skip-cert-verify'] = true;
      if (node.alpn) base.alpn = node.alpn;
      if (node.reality && node.reality.enabled) {
        base['reality-opts'] = {
          'public-key': node.reality.publicKey,
          'short-id': node.reality.shortId || '',
        };
      }
    }
    if (node.network) {
      base.network = node.network;
      if (node.network === 'ws' && node.wsPath) {
        base['ws-opts'] = {
          path: node.wsPath,
          headers: node.wsHeaders || {},
        };
        if (node.maxEarlyData) base['ws-opts']['max-early-data'] = node.maxEarlyData;
        if (node.earlyDataHeaderName) base['ws-opts']['early-data-header-name'] = node.earlyDataHeaderName;
      }
      if (node.network === 'grpc' && node.grpcServiceName) {
        base['grpc-opts'] = {
          'grpc-service-name': node.grpcServiceName,
        };
      }
      if (node.network === 'http' || node.network === 'h2') {
        base['h2-opts'] = {
          host: node.sni ? [node.sni] : [],
          path: node.wsPath || '/',
        };
      }
    }
    return base;
  }

  if (node.type === 'vmess') {
    base.uuid = node.uuid;
    base.alterId = node.alterId || 0;
    base.cipher = node.cipher || 'auto';
    if (node.tls) {
      base.tls = true;
      if (node.sni) base.servername = node.sni;
      if (node.skipCertVerify) base['skip-cert-verify'] = true;
      if (node.fingerprint) base['client-fingerprint'] = node.fingerprint;
    }
    if (node.network) {
      base.network = node.network;
      if (node.network === 'ws' && node.wsPath) {
        base['ws-opts'] = {
          path: node.wsPath,
          headers: node.wsHeaders || {},
        };
        if (node.maxEarlyData) base['ws-opts']['max-early-data'] = node.maxEarlyData;
        if (node.earlyDataHeaderName) base['ws-opts']['early-data-header-name'] = node.earlyDataHeaderName;
      }
      if (node.network === 'grpc' && node.grpcServiceName) {
        base['grpc-opts'] = {
          'grpc-service-name': node.grpcServiceName,
        };
      }
      if (node.network === 'http' || node.network === 'h2') {
        base['h2-opts'] = {
          host: node.sni ? [node.sni] : [],
          path: node.wsPath || '/',
        };
      }
    }
    return base;
  }

  if (node.type === 'trojan') {
    base.password = node.password;
    base.tls = true;
    if (node.sni) base.servername = node.sni;
    if (node.fingerprint) base['client-fingerprint'] = node.fingerprint;
    if (node.alpn) base.alpn = node.alpn;
    if (node.skipCertVerify) base['skip-cert-verify'] = true;
    if (node.network) {
      base.network = node.network;
      if (node.network === 'ws' && node.wsPath) {
        base['ws-opts'] = {
          path: node.wsPath,
          headers: node.wsHeaders || {},
        };
        if (node.maxEarlyData) base['ws-opts']['max-early-data'] = node.maxEarlyData;
        if (node.earlyDataHeaderName) base['ws-opts']['early-data-header-name'] = node.earlyDataHeaderName;
      }
      if (node.network === 'grpc' && node.grpcServiceName) {
        base['grpc-opts'] = {
          'grpc-service-name': node.grpcServiceName,
        };
      }
      if (node.network === 'http' || node.network === 'h2') {
        base['h2-opts'] = {
          host: node.sni ? [node.sni] : [],
          path: node.wsPath || '/',
        };
      }
    }
    return base;
  }

  if (node.type === 'hysteria2') {
    base.password = node.password;
    base.tls = true;
    if (node.sni) base.sni = node.sni;
    if (node.serverPorts && node.serverPorts.length > 0) {
      const portsList = Array.isArray(node.serverPorts)
        ? node.serverPorts
        : String(node.serverPorts).split(',');
      const formattedPorts = portsList
        .map((s: any) => String(s).trim().replace(':', '-'))
        .filter(Boolean);
      if (formattedPorts.length > 0) {
        base.ports = formattedPorts.join(',');
      }
    }
    if (node.hopInterval) base['hop-interval'] = node.hopInterval;
    if (node.upMbps) base.up = `${node.upMbps} Mbps`;
    if (node.downMbps) base.down = `${node.downMbps} Mbps`;
    if (node.alpn) base.alpn = node.alpn;
    if (node.skipCertVerify) base['skip-cert-verify'] = true;
    if (node.fingerprint) base['client-fingerprint'] = node.fingerprint;
    if (node.obfsPassword || node.obfs) {
      base.obfs = node.obfs || 'salamander';
      base['obfs-password'] = node.obfsPassword || node.obfs;
    }
    return base;
  }

  if (node.type === 'tuic') {
    base.uuid = node.uuid || node.password;
    base.password = node.password;
    base.tls = true;
    if (node.sni) base.sni = node.sni;
    if (node.alpn) base.alpn = node.alpn;
    if (node.quicCongestionControl) base['congestion-controller'] = node.quicCongestionControl;
    if (node.udpRelayMode) base['udp-relay-mode'] = node.udpRelayMode;
    if (node.heartbeat) base['heartbeat-interval'] = node.heartbeat;
    if (node.zeroRttHandshake !== undefined) base['reduce-rtt'] = node.zeroRttHandshake;
    if (node.skipCertVerify) base['skip-cert-verify'] = true;
    return base;
  }

  if (node.type === 'naive') {
    base.username = node.username;
    base.password = node.password;
    base.sni = node.sni;
    if (node.quic) {
      base.quic = true;
    }
    if (node.skipCertVerify) base['skip-cert-verify'] = true;
    return base;
  }

  if (node.type === 'wireguard') {
    base.ip = node.ip || '10.0.0.2';
    if (node.ipv6) base.ipv6 = node.ipv6;
    base['private-key'] = node.privateKey || '';
    base['public-key'] = node.publicKey || '';
    if (node.presharedKey) base['preshared-key'] = node.presharedKey;
    if (node.reserved) base.reserved = node.reserved;
    if (node.mtu) base.mtu = node.mtu;
    base.udp = node.udp !== undefined ? node.udp : true;
    base['remote-dns-resolve'] = node.remoteDnsResolve !== undefined ? node.remoteDnsResolve : true;
    return base;
  }

  if (node.type === 'snell') {
    base.psk = node.psk || node.password || '';
    base.version = node.snellVersion || 4;
    if (node.obfs) {
      base['obfs-opts'] = {
        mode: node.obfs,
        host: node.obfsHost || '',
      };
    }
    return base;
  }

  if (node.type === 'anytls') {
    base.password = node.password || '';
    if (node.sni) base.sni = node.sni;
    if (node.alpn) base.alpn = node.alpn;
    if (node.skipCertVerify) base['skip-cert-verify'] = true;
    if (node.fingerprint) base['client-fingerprint'] = node.fingerprint;
    if (node.idleSessionTimeout) base['idle-session-timeout'] = node.idleSessionTimeout;
    if (node.idleSessionCheckInterval) base['idle-session-check-interval'] = node.idleSessionCheckInterval;
    if (node.minIdleSession) base['min-idle-session'] = node.minIdleSession;
    return base;
  }

  if (node.type === 'socks5') {
    base.type = 'socks5';
    if (node.username) base.username = node.username;
    if (node.password) base.password = node.password;
    if (node.tls) {
      base.tls = true;
      if (node.sni) base.sni = node.sni;
      if (node.skipCertVerify) base['skip-cert-verify'] = true;
      if (node.fingerprint) base['client-fingerprint'] = node.fingerprint;
    }
    base.udp = node.udp !== undefined ? node.udp : true;
    return base;
  }

  return base;
}

export interface MihomoGeneratorOptions {
  expandNodes?: boolean;
  baseUrl?: string;
  subToken?: string;
  ordinaryNodeIds?: ReadonlySet<string>;
  dependencyGroupIds?: ReadonlySet<string>;
}

export function generateMihomoConfig(
  templateYaml: string,
  nodes: ProxyNode[],
  proxyGroups: ProxyGroupItem[] = [],
  rulesList: UnifiedRuleItem[] = [],
  sources: SubscriptionSource[] = [],
  options?: MihomoGeneratorOptions
): string {
  let doc: any;
  try {
    doc = yaml.load(templateYaml) as any;
  } catch (e) {
    doc = {};
  }
  if (!doc || typeof doc !== 'object') {
    doc = {};
  }

  const expandNodes = Boolean(options?.expandNodes);
  const hasSuboneRemoteSubscription = Boolean(options?.baseUrl && options?.subToken && !expandNodes);

  // 1. Inject Custom / Manual / Filter Proxies directly (if any)
  const networkSources = sources.filter(s => s.enabled && s.type !== 'custom' && s.type !== 'filter' && s.url && s.url.startsWith('http'));
  const networkSourceIds = new Set(networkSources.map(s => s.id));

  const allNodesMap = new Map<string, ProxyNode>();
  nodes.forEach(n => allNodesMap.set(n.name, n));
  sources.forEach(s => {
    if ((s.type === 'filter' || s.type === 'custom' || s.type === 'manual' || !s.url || !s.url.startsWith('http')) && Array.isArray(s.nodes)) {
      s.nodes.forEach(n => {
        if (!allNodesMap.has(n.name)) allNodesMap.set(n.name, n);
      });
    }
  });
  const allCandidateNodes = Array.from(allNodesMap.values());

  let nodesToWrite: ProxyNode[] = [];
  if (expandNodes) {
    nodesToWrite = allCandidateNodes;
  } else if (!hasSuboneRemoteSubscription) {
    nodesToWrite = networkSources.length > 0
      ? allCandidateNodes.filter(n => !n.sourceId || n.sourceId === 'custom' || n.sourceId.startsWith('custom') || !networkSourceIds.has(n.sourceId))
      : allCandidateNodes;
  } else {
    // 订阅化模式：由 proxy-providers 接管自建源
    nodesToWrite = options?.ordinaryNodeIds ? nodes.filter(node => !options.ordinaryNodeIds!.has(node.id)) : [];
  }

  doc.proxies = [...(Array.isArray(doc.proxies) ? doc.proxies : []), ...nodesToWrite.map(nodeToMihomoProxy)];

  // 2. Inject Proxy Groups & Unified Rules & Proxy Providers & DNS
  doc = injectUnifiedToMihomo(doc, nodes, proxyGroups, rulesList, sources, options);

  return yaml.dump(doc, {
    indent: 2,
    lineWidth: -1,
    noRefs: true,
  });
}

export function injectUnifiedToMihomo(
  doc: any,
  nodes: ProxyNode[],
  proxyGroups: ProxyGroupItem[],
  rulesList: UnifiedRuleItem[],
  sources: SubscriptionSource[] = [],
  options?: MihomoGeneratorOptions
): any {

  if (!doc || typeof doc !== 'object') doc = {};

  const networkSources = sources.filter(s => s.enabled && s.type !== 'custom' && s.type !== 'filter' && s.url && s.url.startsWith('http'));
  const internalSources = sources.filter(s => s.enabled && !networkSources.some(ns => ns.id === s.id));
  const hasSuboneRemoteSubscription = Boolean(options?.baseUrl && options?.subToken && !options?.expandNodes);

  const customNodes = nodes.filter(n => n.sourceId === 'custom' || n.sourceId?.startsWith('custom') || !n.sourceId);
  const customNodeNames = customNodes.map(n => n.name);

  // 1. Inject Proxy Providers for network subscriptions and internal sources
  const allActiveRemoteSources: SubscriptionSource[] = [];

  if (!options?.expandNodes) {
    if (!doc['proxy-providers'] || typeof doc['proxy-providers'] !== 'object') {
      doc['proxy-providers'] = {};
    }

    // 外部机场源
    networkSources.forEach(s => {
      const providerKey = s.name.trim();
      const safePathName = providerKey
        .replace(/^[⚡️🚀👉♻️🌐📹✈️🤖🇨🇳🇭🇰🇯🇵🇺🇸🏮🇸🇬\s]+/u, '')
        .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
        .replace(/\.{2,}/g, '_')
        .trim() || s.id || 'provider';

      doc['proxy-providers'][providerKey] = {
        type: 'http',
        url: options?.ordinaryNodeIds && options.baseUrl && options.subToken
          ? `${options.baseUrl.replace(/\/+$/, '')}/s/${encodeURIComponent(options.subToken)}/source/${encodeURIComponent(s.id)}?target=mihomo`
          : sourceSubscriptionUrl(s, 'mihomo', options),
        interval: 86400,
        path: `./proxy_providers/${safePathName}.yaml`,
        'health-check': {
          enable: true,
          url: 'https://www.google.com/generate_204',
          interval: 300,
        },
      };
      allActiveRemoteSources.push(s);
    });

    // 内部自建/过滤/独立源转为 proxy-provider
    if (hasSuboneRemoteSubscription && options?.baseUrl && options?.subToken) {
      const cleanBaseUrl = options.baseUrl.replace(/\/+$/, '');
      const token = encodeURIComponent(options.subToken);
      internalSources.forEach(s => {
        const providerKey = s.name.trim();
        const safePathName = providerKey
          .replace(/^[⚡️🚀👉♻️🌐📹✈️🤖🇨🇳🇭🇰🇯🇵🇺🇸🏮🇸🇬\s]+/u, '')
          .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
          .replace(/\.{2,}/g, '_')
          .trim() || s.id || 'provider';

        doc['proxy-providers'][providerKey] = {
          type: 'http',
          url: `${cleanBaseUrl}/s/${token}/source/${encodeURIComponent(s.id)}?target=mihomo`,
          interval: 86400,
          path: `./proxy_providers/${safePathName}.yaml`,
          'health-check': {
            enable: true,
            url: 'https://www.google.com/generate_204',
            interval: 300,
          },
        };
        allActiveRemoteSources.push(s);
      });
    }
  }

  const allProviderNames = allActiveRemoteSources.map(s => s.name.trim());

  // 2. Build Proxy Groups
  const effectiveGroups: ProxyGroupItem[] = proxyGroups.map(g => ({
    ...g,
    proxies: g.proxies ? [...g.proxies] : undefined,
    use: g.use ? [...g.use] : (g.sources ? [...g.sources] : undefined),
  }));

  const validGroupNames = new Set(effectiveGroups.map(g => g.name));
  // Provider nodes are resolved through `use`, not the static proxy map.
  const validNodeNames = new Set<string>(
    Array.isArray(doc.proxies) ? doc.proxies.map((proxy: any) => String(proxy.name)) : []
  );

  const isBuiltinClashProxy = (t: string) => {
    const upper = t.trim().toUpperCase();
    return (
      upper === 'DIRECT' ||
      upper === 'REJECT' ||
      upper === 'PASS' ||
      upper === 'COMPATIBLE' ||
      upper === 'GLOBAL' ||
      t.trim() === '🎯 本地直连'
    );
  };

  const generatedGroups: any[] = [];
  effectiveGroups.forEach(grp => {
    const candidates = options?.ordinaryNodeIds && !options.dependencyGroupIds?.has(grp.id) ? nodes.filter(node => options.ordinaryNodeIds!.has(node.id)) : nodes;
    if (grp.type === 'direct') {
      generatedGroups.push({
        name: grp.name,
        type: 'select',
        proxies: ['DIRECT'],
      });
      return;
    }
    if (grp.type === 'reject') {
      generatedGroups.push({
        name: grp.name,
        type: 'select',
        proxies: ['REJECT'],
      });
      return;
    }

    if (grp.type === 'relay') {
      throw new UnsupportedProxyGroupError('Mihomo', grp.name);
    }

    const groupType = grp.type === 'urltest' ? 'url-test' : (grp.type === 'load-balance' ? 'load-balance' : grp.type);
    const grpObj: any = {
      name: grp.name,
      type: groupType,
    };

    for (const key of ['icon', 'hidden', 'lazy', 'url', 'interval'] as const) {
      if (grp[key] !== undefined) grpObj[key] = grp[key];
    }
    if (groupType === 'load-balance') {
      grpObj.strategy = grp.strategy || 'consistent-hashing';
      grpObj.url = grp.url || 'https://www.gstatic.com/generate_204';
      grpObj.interval = grp.interval || 300;
    }

    if (groupType === 'url-test' || groupType === 'fallback') {
      grpObj.url = grp.url || 'https://www.google.com/generate_204';
      grpObj.interval = grp.interval || 300;
      grpObj.tolerance = grp.tolerance || 50;
    }

    // 匹配来源
    const combinedProxies = new Set<string>(grp.proxies || []);
    const groupUses = grp.use || grp.sources || [];

    const acceptsNodes = grp.includeAll || Boolean(grp.filter) || groupUses.length > 0 ||
      ['👉 手动选择', '♻️ 自动选择'].includes(grp.name);
    if (options?.expandNodes && acceptsNodes) {
      const groupSources = options?.dependencyGroupIds?.has(grp.id)
        ? [...sources, ...candidates.filter(node => node.sourceId && !sources.some(source => source.id === node.sourceId)).map(node => ({ id: node.sourceId!, name: node.sourceName || node.sourceId!, enabled: true, nodes: [] } as unknown as SubscriptionSource))]
        : sources;
      resolveGroupNodes(grp, candidates, groupSources).forEach(n => combinedProxies.add(n.name));
      grpObj.proxies = Array.from(combinedProxies).filter(p => p !== grp.name);
      if (!grpObj.proxies.length && !options?.dependencyGroupIds?.has(grp.id)) grpObj.proxies = ['REJECT'];
      generatedGroups.push(grpObj);
      return;
    }

    // 检查是否有对应的 remote provider
    const matchedProviders: string[] = [];
    const matchedManualNodes: string[] = [];

    // 若策略组名字直接匹配某个源
    const cleanGrpName = cleanSourceOrGroupName(grp.name).toLowerCase();
    const selfMatchedSource = sources.find(s => {
      const sClean = cleanSourceOrGroupName(s.name).toLowerCase();
      return sClean === cleanGrpName || s.id.toLowerCase() === cleanGrpName;
    });
    if (selfMatchedSource) {
      if (allProviderNames.includes(selfMatchedSource.name.trim())) {
        matchedProviders.push(selfMatchedSource.name.trim());
      } else if (Array.isArray(selfMatchedSource.nodes)) {
        selfMatchedSource.nodes.forEach(n => matchedManualNodes.push(n.name));
      }
    }

    // 处理 groupUses 中显式引用的源
    groupUses.forEach(u => {
      const cleanU = cleanSourceOrGroupName(u).toLowerCase();
      const matchedSource = sources.find(s => {
        const sClean = cleanSourceOrGroupName(s.name).toLowerCase();
        return sClean === cleanU || s.id.toLowerCase() === cleanU || s.name.trim().toLowerCase() === u.trim().toLowerCase();
      });

      if (matchedSource) {
        if (allProviderNames.includes(matchedSource.name.trim())) {
          matchedProviders.push(matchedSource.name.trim());
        } else if (Array.isArray(matchedSource.nodes)) {
          matchedSource.nodes.forEach(n => matchedManualNodes.push(n.name));
        }
      } else {
        // 可能引用了另一个策略组
        const matchedGrp = effectiveGroups.find(g => cleanSourceOrGroupName(g.name).toLowerCase() === cleanU);
        if (matchedGrp) {
          combinedProxies.add(matchedGrp.name);
        }
      }
    });

    if (matchedProviders.length > 0) {
      grpObj.use = Array.from(new Set(matchedProviders));
    }
    if (grp.includeAll && !grpObj.use && groupUses.length === 0 && !selfMatchedSource && allProviderNames.length) {
      grpObj.use = allProviderNames;
    }

    // 处理 filter 正则
    if (grp.filter) {
      grpObj.filter = grp.filter;
      // 未选择节点来源时，才包含所有远程 providers。
      if (!grpObj.use && groupUses.length === 0 && !selfMatchedSource && allProviderNames.length > 0) {
        grpObj.use = allProviderNames;
      }
      // 对于 manual 节点，应用 filter
      try {
        const reg = new RegExp(grp.filter.replace(/\(\?i\)/g, ''), 'i');
        const candidateManual = matchedManualNodes.length > 0
          ? matchedManualNodes
          : (groupUses.length > 0 || selfMatchedSource ? [] : Array.from(validNodeNames));
        candidateManual.filter(name => reg.test(name)).forEach(name => combinedProxies.add(name));
      } catch {
        matchedManualNodes.forEach(name => combinedProxies.add(name));
      }
    } else {
      matchedManualNodes.forEach(name => combinedProxies.add(name));
    }

    // 默认回落到所有 provider
    if (!grpObj.use && combinedProxies.size === 0) {
      if (allProviderNames.length > 0 && (grp.name === '🚀 节点选择' || grp.name === '👉 手动选择' || grp.name === '♻️ 自动选择')) {
        grpObj.use = allProviderNames;
      }
    }

    const filteredProxies = Array.from(combinedProxies).filter(p => {
      if (!p || p.trim() === grp.name) return false;
      const t = p.trim();
      return options?.dependencyGroupIds?.has(grp.id) || validGroupNames.has(t) || validNodeNames.has(t) || isBuiltinClashProxy(t);
    });

    if (filteredProxies.length > 0) {
      grpObj.proxies = filteredProxies;
    }

    if ((!grpObj.proxies || grpObj.proxies.length === 0) && (!grpObj.use || grpObj.use.length === 0)) {
      grpObj.proxies = options?.dependencyGroupIds?.has(grp.id) ? [] : ['DIRECT'];
    }

    generatedGroups.push(grpObj);
  });

  doc['proxy-groups'] = [...(Array.isArray(doc['proxy-groups']) ? doc['proxy-groups'] : []), ...generatedGroups];

  // 2. Build Remote Rule Providers
  const activeRules = rulesList.filter(r => r.enabled);
  const remoteRules = activeRules.filter(r => r.kind === 'remote');
  const localRules = activeRules.filter(r => r.kind === 'local');

  if (remoteRules.length > 0) {
    if (!doc['rule-providers'] || typeof doc['rule-providers'] !== 'object') {
      doc['rule-providers'] = {};
    }
    remoteRules.forEach((r, idx) => {
      const provider = adaptRulesetForMihomo(r, idx);
      doc['rule-providers'][provider.tag] = {
        type: 'http',
        behavior: provider.behavior,
        format: provider.format,
        path: provider.path,
        url: provider.url,
        interval: 86400,
      };
    });
  }

  // 3. Build Rules
  const availableGroupNames = new Set<string>((doc['proxy-groups'] || []).map((g: any) => String(g.name)));
  const fallbackGroup = (doc['proxy-groups'] || []).find((g: any) => g.name === '🚀 节点选择')?.name || doc['proxy-groups']?.[0]?.name || 'DIRECT';

  const generatedRules: string[] = [];
  activeRules.forEach((r, idx) => {
    const safeOutbound = resolveSafeOutbound(r.outbound, availableGroupNames, fallbackGroup);
    if (r.type === 'FINAL') return; // final rule at the end
    const suffix = r.noResolve ? ',no-resolve' : '';
    if (r.kind === 'remote') {
      generatedRules.push(`RULE-SET,${formatRuleTag(r, remoteRules.indexOf(r))},${safeOutbound}${suffix}`);
      return;
    }
    r.payload.split(/[,;\n]+/).map(p => p.trim()).filter(Boolean).forEach(item => {
      const value = r.type === 'SRC-IP-CIDR' ? formatCidr(item) : item;
      generatedRules.push(`${r.type},${value},${safeOutbound}${suffix}`);
    });
  });

  const existingRules = Array.isArray(doc.rules) ? doc.rules : [];
  const existingPreRules = existingRules.filter((r: any) => typeof r === 'string' && !r.trim().toUpperCase().startsWith('MATCH,'));
  const existingMatch = existingRules.find((r: any) => typeof r === 'string' && r.trim().toUpperCase().startsWith('MATCH,'));

  const finalRule = activeRules.find(r => r.type === 'FINAL');
  const finalMatch = finalRule
    ? `MATCH,${resolveSafeOutbound(finalRule.outbound, availableGroupNames, fallbackGroup)}`
    : existingMatch || (availableGroupNames.has('🐟 漏网之鱼') ? 'MATCH,🐟 漏网之鱼' : `MATCH,${fallbackGroup}`);

  const postRules = Array.isArray(doc.post_rules)
    ? doc.post_rules
    : Array.isArray(doc['post-rules'])
    ? doc['post-rules']
    : [];
  delete doc.post_rules;
  delete doc['post-rules'];

  doc.rules = [...existingPreRules, ...generatedRules, ...postRules, finalMatch];

  return doc;
}
