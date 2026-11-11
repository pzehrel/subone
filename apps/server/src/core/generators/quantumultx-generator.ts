import { quantumultXOwnedNames, quantumultXEntries } from '../quantumultx-config';
import { ProxyNode, ProxyGroupItem, UnifiedRuleItem, SubscriptionSource } from '../../types/index';
import { resolveGroupNodes } from './group-nodes';
import { UnsupportedProxyGroupError } from './errors';
import { adaptRulesetForQuantumultX, formatRuleTag } from './ruleset-adapter';
import { sourceSubscriptionUrl, resolveSafeOutbound, formatCidr, cleanSourceOrGroupName, formatSourceGroupTag, resolveGroupIcon, DEFAULT_QX_ICON_BASE } from './common';

export function nodeToQuantumultXProxy(node: ProxyNode): string {
  const tag = node.name.replace(/[=,]/g, '_');
  const cleanServer = (node.server || '').trim().replace(/^\[(.*)\]$/, '$1');
  const serverWithPort = cleanServer.includes(':') && !cleanServer.startsWith('[')
    ? `[${cleanServer}]:${node.port}`
    : `${cleanServer}:${node.port}`;

  if (node.network === 'grpc') {
    return `# Unsupported on Quantumult X (gRPC transport is not supported by QX): ${tag}`;
  }

  if (node.type === 'anytls') {
    let line = `anytls=${serverWithPort}, password=${node.password || ''}, over-tls=true`;
    if (node.sni) line += `, tls-host=${node.sni}`;
    if (node.skipCertVerify !== undefined) line += `, tls-verification=${!node.skipCertVerify}`;
    if (node.reality?.enabled && node.reality.publicKey) {
      line += `, reality-base64-pubkey=${node.reality.publicKey}`;
      if (node.reality.shortId) {
        line += `, reality-hex-shortid=${node.reality.shortId}`;
      }
    }
    line += `, udp-relay=true, tag=${tag}`;
    return line;
  }

  if (node.type === 'vless') {
    const method = 'none';
    let line = `vless=${serverWithPort}, method=${method}, password=${node.uuid || ''}`;
    if (node.network === 'ws') {
      const host = node.wsHeaders?.Host || node.wsHeaders?.host || node.sni || cleanServer;
      const obfsType = (node.tls || node.reality?.enabled) ? 'wss' : 'ws';
      line += `, obfs=${obfsType}, obfs-host=${host}, obfs-uri=${node.wsPath || '/'}`;
    } else {
      if (node.tls || node.reality?.enabled) {
        line += `, obfs=over-tls, obfs-host=${node.sni || cleanServer}`;
      }
    }

    if (node.reality?.enabled && node.reality.publicKey) {
      line += `, reality-base64-pubkey=${node.reality.publicKey}`;
      if (node.reality.shortId) {
        line += `, reality-hex-shortid=${node.reality.shortId}`;
      }
    }

    if (node.flow?.includes('vision')) {
      line += `, vless-flow=xtls-rprx-vision`;
    }

    line += `, fast-open=false, udp-relay=true, tag=${tag}`;
    return line;
  }

  if (node.type === 'ss' || node.type === 'ssr') {
    const method = node.method || 'aes-128-gcm';
    let line = `shadowsocks=${serverWithPort}, method=${method}, password=${node.password || ''}`;
    if (node.type === 'ssr') {
      if (node.protocol) line += `, ssr-protocol=${node.protocol}`;
      if (node.protocolParam) line += `, ssr-protocol-param=${node.protocolParam}`;
      if (node.obfs) line += `, obfs=${node.obfs}`;
      if (node.obfsParam) line += `, obfs-host=${node.obfsParam}`;
    } else if (node.reality?.enabled && node.reality.publicKey) {
      line += `, obfs=over-tls, obfs-host=${node.sni || cleanServer}, reality-base64-pubkey=${node.reality.publicKey}`;
      if (node.reality.shortId) {
        line += `, reality-hex-shortid=${node.reality.shortId}`;
      }
    } else if (node.plugin === 'obfs') {
      line += `, obfs=${node.pluginOpts?.mode || 'http'}, obfs-host=${node.pluginOpts?.host || ''}`;
    } else if (node.plugin === 'v2ray-plugin') {
      line += `, obfs=${node.pluginOpts?.tls ? 'wss' : 'ws'}, obfs-uri=${node.pluginOpts?.path || '/'}, obfs-host=${node.pluginOpts?.host || ''}`;
    }
    line += `, fast-open=false, udp-relay=true, tag=${tag}`;
    return line;
  }

  if (node.type === 'trojan') {
    let line = `trojan=${serverWithPort}, password=${node.password || ''}`;
    if (node.network === 'ws') {
      const host = node.wsHeaders?.Host || node.wsHeaders?.host || node.sni;
      const obfsType = (node.tls || node.reality?.enabled) ? 'wss' : 'ws';
      if (host) line += `, obfs=${obfsType}, obfs-host=${host}, obfs-uri=${node.wsPath || '/'}`;
      else line += `, obfs=${obfsType}, obfs-uri=${node.wsPath || '/'}`;
    } else {
      line += `, over-tls=true`;
      if (node.sni) line += `, tls-host=${node.sni}`;
      const verify = node.skipCertVerify ? 'false' : 'true';
      line += `, tls-verification=${verify}`;
    }

    if (node.reality?.enabled && node.reality.publicKey) {
      line += `, reality-base64-pubkey=${node.reality.publicKey}`;
      if (node.reality.shortId) {
        line += `, reality-hex-shortid=${node.reality.shortId}`;
      }
    }

    line += `, fast-open=false, udp-relay=true, tag=${tag}`;
    return line;
  }

  if (node.type === 'vmess') {
    const method = (node.cipher === 'auto' || !node.cipher) ? 'none' : node.cipher;
    let line = `vmess=${serverWithPort}, method=${method}, password=${node.uuid || ''}`;
    if (node.reality?.enabled && node.reality.publicKey) {
      line += `, obfs=over-tls, obfs-host=${node.sni || cleanServer}, reality-base64-pubkey=${node.reality.publicKey}`;
      if (node.reality.shortId) {
        line += `, reality-hex-shortid=${node.reality.shortId}`;
      }
    } else if (node.network === 'ws') {
      const host = node.wsHeaders?.Host || node.wsHeaders?.host || node.sni;
      const obfsType = node.tls ? 'wss' : 'ws';
      if (host) line += `, obfs=${obfsType}, obfs-host=${host}, obfs-uri=${node.wsPath || '/'}`;
      else line += `, obfs=${obfsType}, obfs-uri=${node.wsPath || '/'}`;
    } else if (node.tls) {
      line += `, obfs=over-tls`;
      if (node.sni) line += `, obfs-host=${node.sni}`;
      const verify = node.skipCertVerify ? 'false' : 'true';
      line += `, tls-verification=${verify}`;
    }
    line += `, fast-open=false, udp-relay=true, tag=${tag}`;
    return line;
  }

  if (node.type === 'socks5') {
    let line = `socks5=${serverWithPort}`;
    if (node.username) line += `, username=${node.username}`;
    if (node.password) line += `, password=${node.password}`;
    if (node.tls) {
      line += `, over-tls=true`;
      if (node.sni) line += `, tls-host=${node.sni}`;
    }
    line += `, fast-open=false, udp-relay=true, tag=${tag}`;
    return line;
  }

  if (node.type === 'http') {
    let line = `http=${serverWithPort}`;
    if (node.username) line += `, username=${node.username}`;
    if (node.password) line += `, password=${node.password}`;
    if (node.tls) {
      line += `, over-tls=true`;
      if (node.sni) line += `, tls-host=${node.sni}`;
    }
    line += `, fast-open=false, tag=${tag}`;
    return line;
  }

  return `# Unsupported on Quantumult X (${node.type.toUpperCase()}): ${tag}`;
}

export interface QuantumultXGeneratorOptions {
  expandNodes?: boolean;
  baseUrl?: string;
  subToken?: string;
  ordinaryNodeIds?: ReadonlySet<string>;
  dependencyGroupIds?: ReadonlySet<string>;
  runtimeSources?: SubscriptionSource[];
  nodeResource?: { name: string; url: string };
}

export function generateQuantumultXConfig(
  templateConf: string,
  nodes: ProxyNode[],
  proxyGroups: ProxyGroupItem[] = [],
  rulesList: UnifiedRuleItem[] = [],
  sources: SubscriptionSource[] = [],
  options?: QuantumultXGeneratorOptions
): string {
  const expandNodes = Boolean(options?.expandNodes);
  const hasSuboneRemoteSubscription = Boolean(options?.baseUrl && options?.subToken && !expandNodes);
  const lines = templateConf.split('\n');
  const resultLines: string[] = [];

  const allNodesMap = new Map<string, ProxyNode>();
  nodes.forEach(n => allNodesMap.set(n.name, n));
  sources.forEach(s => {
    if ((s.type === 'filter' || s.type === 'custom' || !s.url || !s.url.startsWith('http')) && Array.isArray(s.nodes)) {
      s.nodes.forEach(n => {
        if (!allNodesMap.has(n.name)) allNodesMap.set(n.name, n);
      });
    }
  });
  const allCandidateNodes = Array.from(allNodesMap.values());

  const networkSourceIds = new Set(
    sources.filter(s => s.enabled && s.type !== 'custom' && s.type !== 'filter' && s.url && s.url.startsWith('http')).map(s => s.id)
  );

  let nodesToWrite: ProxyNode[] = [];
  if (expandNodes) {
    nodesToWrite = allCandidateNodes;
  } else if (!hasSuboneRemoteSubscription) {
    nodesToWrite = allCandidateNodes.filter(n => !n.sourceId || n.sourceId === 'custom' || n.sourceId.startsWith('custom') || !networkSourceIds.has(n.sourceId));
  } else {
    // 订阅化模式：由 server_remote 接管自建源
    nodesToWrite = allCandidateNodes.filter(node => options?.ordinaryNodeIds && !options.ordinaryNodeIds.has(node.id));
  }

  const generatedProxyLines = nodesToWrite.map(nodeToQuantumultXProxy);

  let inServerLocal = false;
  let serverLocalWritten = false;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim().toLowerCase();

    if (trimmed.startsWith('[server_local]')) {
      inServerLocal = true;
      resultLines.push(rawLine);
      if (generatedProxyLines.length > 0) {
        resultLines.push(...generatedProxyLines);
        serverLocalWritten = true;
      }
      continue;
    }

    if (trimmed.startsWith('[') && inServerLocal) {
      inServerLocal = false;
    }

    resultLines.push(rawLine);
  }

  if (!serverLocalWritten && generatedProxyLines.length > 0) {
    resultLines.push('\n[server_local]');
    resultLines.push(...generatedProxyLines);
  }

  const baseConfig = resultLines.join('\n');
  return injectUnifiedToQuantumultX(baseConfig, nodes, proxyGroups, rulesList, sources, options);
}

export function isSupportedByQuantumultX(node: ProxyNode): boolean {
  if (node.network === 'grpc') return false;
  if (node.type === 'anytls') return true;
  if (node.type === 'vless') return true;
  if (node.type === 'trojan') return true;
  if (node.type === 'ss' || node.type === 'ssr') return true;
  if (node.type === 'vmess') return true;
  if (node.type === 'socks5') return true;
  if (node.type === 'http') return true;
  return false;
}

function quantumultXGroupType(group: ProxyGroupItem): string {
  if (group.type === 'load-balance') return group.strategy === 'consistent-hashing' ? 'dest-hash' : 'round-robin';
  if (group.type === 'urltest') return 'url-latency-benchmark';
  if (group.type === 'fallback') return 'available';
  return 'static';
}

export function injectUnifiedToQuantumultX(
  templateConf: string,
  nodes: ProxyNode[],
  proxyGroups: ProxyGroupItem[],
  rulesList: UnifiedRuleItem[],
  sources: SubscriptionSource[] = [],
  options?: QuantumultXGeneratorOptions
): string {
  const expandNodes = Boolean(options?.expandNodes);
  const staticGroups = expandNodes || Boolean(options?.nodeResource) || Boolean(options?.ordinaryNodeIds && nodes.some(node => !options.ordinaryNodeIds!.has(node.id)));
  const nodeOutputNames = new Map(nodes.filter(isSupportedByQuantumultX).map(node => [node.name, node.name.replace(/[=,]/g, '_')]));
  nodes = nodes.filter(node => !options?.ordinaryNodeIds || options.ordinaryNodeIds.has(node.id));
  const lines = templateConf.split('\n');
  const activeRules = rulesList.filter(r => r.enabled);
  const remoteRules = activeRules.filter(r => r.kind === 'remote');
  const localRules = activeRules.filter(r => r.kind === 'local' && r.type !== 'FINAL');

  const effectiveGroups: ProxyGroupItem[] = proxyGroups.map(g => ({
    ...g,
    proxies: g.proxies ? [...g.proxies] : undefined,
    use: g.use ? [...g.use] : undefined,
  }));

  const networkSources = sources.filter(s => s.enabled && s.type !== 'custom' && s.type !== 'filter' && s.url && s.url.startsWith('http'));
  // 内部真实物理自建源（排除 filter 筛选源，避免同一批节点被作为两个订阅重复拉取导致节点重复冲突和警告标）
  const internalPhysicalSources = sources.filter(s => s.enabled && s.type !== 'filter' && !networkSources.some(ns => ns.id === s.id));
  const hasSuboneRemoteSubscription = Boolean(options?.baseUrl && options?.subToken && !expandNodes);

  const customNodes = nodes.filter(n => n.sourceId === 'custom' || n.sourceId?.startsWith('custom') || !n.sourceId);
  const qxSupportedNodes = nodes.filter(isSupportedByQuantumultX);
  const qxSupportedCustomNodes = customNodes.filter(isSupportedByQuantumultX);
  const customNodeNames = qxSupportedCustomNodes.map(n => n.name.replace(/[=,]/g, '_'));
  const allNodeNames = qxSupportedNodes.map(n => n.name.replace(/[=,]/g, '_'));

  const customSources = sources.filter(s => s.type === 'custom' || s.id === 'custom');
  const customTagName = customSources[0]?.name
    ? formatSourceGroupTag(customSources[0])
    : '🖥️ 独立节点组';

  // Sanitize effectiveGroups: if there is a custom group, sync its name to customTagName and remove any stale custom group aliases
  const customGrp = effectiveGroups.find(g =>
    g.id === 'grp-src-custom' ||
    g.name === customTagName ||
    cleanSourceOrGroupName(g.name) === '独立节点组' ||
    cleanSourceOrGroupName(g.name) === '自建节点'
  );
  if (customGrp) {
    customGrp.name = customTagName;
    customGrp.use = [cleanSourceOrGroupName(customSources[0]?.name || '独立节点组')];
    const idx = effectiveGroups.indexOf(customGrp);
    for (let i = effectiveGroups.length - 1; i >= 0; i--) {
      if (i !== idx) {
        const g = effectiveGroups[i];
        if (g.id === 'grp-src-custom' || cleanSourceOrGroupName(g.name) === '独立节点组' || cleanSourceOrGroupName(g.name) === '自建节点') {
          effectiveGroups.splice(i, 1);
        }
      }
    }
    effectiveGroups.forEach(grp => {
      if (grp !== customGrp) {
        if (grp.use) {
          grp.use = grp.use.map(u => (cleanSourceOrGroupName(u) === '独立节点组' || cleanSourceOrGroupName(u) === '自建节点' ? cleanSourceOrGroupName(customSources[0]?.name || '独立节点组') : u));
        }
        if (grp.proxies) {
          grp.proxies = grp.proxies.map(p => (cleanSourceOrGroupName(p) === '独立节点组' || cleanSourceOrGroupName(p) === '自建节点' ? customTagName : p));
        }
      }
    });
  }

  // 1. Build [server_remote]
  const serverRemoteLines: string[] = [];
  const allActiveRemoteSources: SubscriptionSource[] = [];

  if (!expandNodes && options?.nodeResource) {
    const tag = options.nodeResource.name.replace(/[=,\r\n]/g, '_').trim() || 'SubOne';
    serverRemoteLines.push(`${options.nodeResource.url}, tag=${tag}, update-interval=86400, opt-parser=false, enabled=true`);
  } else if (!expandNodes) {
    networkSources.forEach(s => {
      const tag = s.name.replace(/[=,]/g, '_').trim();
      const iconUrl = resolveGroupIcon(s.name) || `${DEFAULT_QX_ICON_BASE}/Airport.png`;
      const url = options?.baseUrl && options?.subToken
        ? `${options.baseUrl.replace(/\/+$/, '')}/s/${encodeURIComponent(options.subToken)}/source/${encodeURIComponent(s.id)}?target=quantumultx`
        : sourceSubscriptionUrl(s, 'quantumultx', options);
      serverRemoteLines.push(`${url}, tag=${tag}, update-interval=86400, opt-parser=false, img-url=${iconUrl}`);
      allActiveRemoteSources.push(s);
    });

    if (hasSuboneRemoteSubscription && options?.baseUrl && options?.subToken) {
      const cleanBaseUrl = options.baseUrl.replace(/\/+$/, '');
      const token = encodeURIComponent(options.subToken);
      internalPhysicalSources.forEach(s => {
        const tag = s.name.replace(/[=,]/g, '_').trim();
        const iconUrl = resolveGroupIcon(s.name) || `${DEFAULT_QX_ICON_BASE}/Server.png`;
        serverRemoteLines.push(`${cleanBaseUrl}/s/${token}/source/${encodeURIComponent(s.id)}?target=quantumultx, tag=${tag}, update-interval=86400, opt-parser=false, img-url=${iconUrl}`);
        allActiveRemoteSources.push(s);
      });
    }
  }

  // 确保所有启用的源（包括 filter 源与物理源）都有对应的策略组；去重时彻底剥离各种 emoji（✨/🖥️/⚡️ 等），避免重复生成第二套组
  const activeSources = sources.filter(s => s.enabled);
  activeSources.forEach(s => {
    // A managed profile owns its policy selection; source bookkeeping is not a policy.
    if (options?.ordinaryNodeIds) return;
    if (proxyGroups.some(g => g.includeAll)) return;
    const sClean = cleanSourceOrGroupName(s.name).toLowerCase();
    const targetTag = formatSourceGroupTag(s);

    const exists = effectiveGroups.some(g => {
      if (g.id === `grp-src-${s.id}`) return true;
      if (s.id === 'custom' && g.id === 'grp-src-custom') return true;
      if (g.name === targetTag || g.name === s.name) return true;
      const gClean = cleanSourceOrGroupName(g.name).toLowerCase();
      return gClean === sClean;
    });

    if (!exists) {
      effectiveGroups.push({
        id: s.id === 'custom' ? 'grp-src-custom' : `grp-src-${s.id}`,
        name: targetTag,
        type: s.type === 'custom' ? 'select' : (s.type === 'filter' ? 'select' : 'urltest'),
        use: [cleanSourceOrGroupName(s.name)],
        tolerance: 50,
        interval: 300,
        url: 'https://www.google.com/generate_204',
      });
    }
  });

  // 2. Build [policy]
  const nativeNames = quantumultXOwnedNames({ quantumultxLines: lines });
  const validGroupNames = new Set([...nativeNames, ...effectiveGroups.map(g => g.name)]);
  const supportedNodeNames = new Set(allNodeNames);
  const validNodeNames = new Set([...nativeNames, ...allNodeNames]);
  sources.forEach(s => {
    if (Array.isArray(s.nodes)) {
      s.nodes.forEach(n => validNodeNames.add(n.name.replace(/[=,]/g, '_')));
    }
  });

  const groupLines: string[] = [];
  const hashNodeNames = new Set([
    ...nodeOutputNames.values(),
    ...quantumultXEntries({ quantumultxLines: lines })
      .filter(entry => entry.section === 'server_local')
      .flatMap(entry => entry.parts.filter(part => /^\s*tag\s*=/i.test(part)).map(part => part.slice(part.indexOf('=') + 1).trim())),
  ]);
  const policyWithMembers = (type: string, group: ProxyGroupItem, members: string[]) => {
    if (type !== 'dest-hash') return `${type}=${group.name}${members.length ? ', ' + members.join(', ') : ''}`;
    members = members.map(member => nodeOutputNames.get(member) || member);
    // Keep known candidates as server references, including local and dependency nodes.
    if (!members.length || members.some(member => !hashNodeNames.has(member))) {
      throw new Error(`Quantumult X 目标哈希策略组「${group.name}」需要可用节点，不能使用直连、拒绝或其他策略组。`);
    }
    members = [...new Set(members)];
    // With one candidate, static selection preserves the sole egress without a hash policy.
    const effectiveType = members.length === 1 ? 'static' : 'dest-hash';
    return `${effectiveType}=${group.name}, ${members.join(', ')}`;
  };
  const addGroupLine = (line: string, grp: ProxyGroupItem) => {
    if (line.includes('img-url=')) {
      groupLines.push(line);
      return;
    }
    const iconUrl = resolveGroupIcon(grp.name, grp.icon);
    if (iconUrl) {
      groupLines.push(`${line}, img-url=${iconUrl}`);
    } else {
      groupLines.push(line);
    }
  };

  effectiveGroups.forEach(grp => {
    if (grp.type === 'relay') {
      throw new UnsupportedProxyGroupError('Quantumult X', grp.name);
    }
    const groupType = quantumultXGroupType(grp);
    if (options?.dependencyGroupIds?.has(grp.id) && !['direct', 'reject'].includes(grp.type)) {
      const members = [...(grp.proxies || [])];
      if ((grp.sources ?? grp.use)?.length || grp.filter || grp.includeAll || !members.length) {
        for (const node of resolveGroupNodes(grp, nodes, options.runtimeSources || sources).filter(isSupportedByQuantumultX)) if (!members.includes(node.name)) members.push(node.name);
      }
      if (!members.length && !(grp.sources ?? grp.use)?.length && !grp.proxies?.length) members.push('direct');
      addGroupLine(policyWithMembers(groupType, grp, members.map(member => /^(DIRECT|REJECT)$/i.test(member) ? member.toLowerCase() : member)), grp);
      return;
    }
    if (grp.includeAll || ((grp.sources || grp.use || []).length > 0 && !['direct', 'reject'].includes(grp.type))) {
      const explicitMembers = (grp.proxies || []).flatMap(value => {
        const member = value.trim();
        if (!member || member === grp.name) return [];
        if (/^(DIRECT|REJECT)$/i.test(member)) return [member.toLowerCase()];
        if (validGroupNames.has(member)) return [member];
        const nodeName = member.replace(/[=,]/g, '_');
        return supportedNodeNames.has(nodeName) ? [nodeName] : [];
      });
      if (staticGroups) {
        const matchedNodes = resolveGroupNodes(grp, qxSupportedNodes, sources).map(n => n.name.replace(/[=,]/g, '_'));
        const members = Array.from(new Set([...explicitMembers, ...matchedNodes]));
        addGroupLine(policyWithMembers(groupType, grp, members.length ? members : ['reject']), grp);
      } else {
        const normalize = (value: string) => cleanSourceOrGroupName(value).trim().toLowerCase();
        const wanted = new Set((grp.sources || grp.use || []).map(normalize));
        const selectedSources = sources.filter(s => s.enabled && (
          wanted.size === 0 || wanted.has(normalize(s.id)) || wanted.has(normalize(s.name))
        ));
        const selectedRemoteSources = allActiveRemoteSources.filter(s => selectedSources.some(selected => selected.id === s.id));
        const resourceTag = (source: SubscriptionSource) => source.name.replace(/[=,]/g, '_').trim();
        const selectedTags = new Set(selectedRemoteSources.map(resourceTag));
        if (allActiveRemoteSources.some(s => !selectedRemoteSources.some(selected => selected.id === s.id) && selectedTags.has(resourceTag(s)))) {
          throw new Error(`Quantumult X 无法区分策略组「${grp.name}」的订阅来源：订阅名称冲突，请为这些订阅设置不同名称后重试。`);
        }
        const selectedInlineSources = selectedSources.filter(s => !selectedRemoteSources.some(remote => remote.id === s.id));
        const inlineNodes = qxSupportedNodes.filter(n => selectedInlineSources.some(s =>
          n.sourceId === s.id || n.sourceName === s.name || s.nodes?.some(saved => saved.id === n.id)
        ) || (wanted.size === 0 && !n.sourceId && !n.sourceName));
        const matchedNodes = resolveGroupNodes({ ...grp, sources: [], use: [] }, inlineNodes, [])
          .map(n => n.name.replace(/[=,]/g, '_'));
        const members = Array.from(new Set([...explicitMembers, ...matchedNodes]));
        const resourceTags = Array.from(selectedTags).map(tag => tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        const pattern = grp.filter ? `(?i)${grp.filter.replace(/\(\?i\)/g, '')}` : '.*';
        if (resourceTags.length) {
          members.push(`resource-tag-regex=^(?:${resourceTags.join('|')})$, server-tag-regex=${pattern}`);
        }
        addGroupLine(`${groupType}=${grp.name}, ${members.length ? members.join(', ') : 'reject'}`, grp);
      }
      return;
    }
    if (grp.type === 'direct') {
      addGroupLine(`static=${grp.name}, direct`, grp);
      return;
    }
    if (grp.type === 'reject') {
      addGroupLine(`static=${grp.name}, reject`, grp);
      return;
    }

    if (grp.filter) {
      let filterPattern = grp.filter.trim();
      if (!filterPattern.startsWith('(?i)')) {
        filterPattern = `(?i)${filterPattern}`;
      }
      if (staticGroups) {
        let matched: string[] = [];
        try {
          const reg = new RegExp(filterPattern.replace(/^\(\?i\)/i, ''), 'i');
          matched = qxSupportedNodes.filter(n => reg.test(n.name)).map(n => n.name.replace(/[=,]/g, '_'));
        } catch {
          matched = [];
        }
        const members = matched.length > 0 ? matched : ['direct'];
        if (groupType === 'url-latency-benchmark') {
          addGroupLine(`url-latency-benchmark=${grp.name}, ${members.join(', ')}, check-interval=300, tolerance=${grp.tolerance || 50}`, grp);
        } else {
          addGroupLine(policyWithMembers(groupType, grp, members), grp);
        }
      } else {
        // 根据策略组类型生成对应 QX 策略组（若为 select 则为 static，支持手动勾选；若为 urltest 则为自动测速）
        if (grp.type === 'select') {
          addGroupLine(`static=${grp.name}, server-tag-regex=${filterPattern}`, grp);
        } else if (grp.type === 'fallback') {
          addGroupLine(`available=${grp.name}, server-tag-regex=${filterPattern}`, grp);
        } else if (grp.type === 'load-balance') {
          addGroupLine(`${groupType}=${grp.name}, server-tag-regex=${filterPattern}`, grp);
        } else {
          addGroupLine(`url-latency-benchmark=${grp.name}, server-tag-regex=${filterPattern}, check-interval=300, tolerance=${grp.tolerance || 50}`, grp);
        }
      }
      return;
    }

    if (grp.name === '♻️ 自动选择') {
      if (staticGroups) {
        const members = allNodeNames.length > 0 ? allNodeNames : ['direct'];
        addGroupLine(`url-latency-benchmark=${grp.name}, ${members.join(', ')}, check-interval=300, tolerance=${grp.tolerance || 50}`, grp);
      } else {
        addGroupLine(`url-latency-benchmark=${grp.name}, server-tag-regex=.*, check-interval=300, tolerance=${grp.tolerance || 50}`, grp);
      }
      return;
    }

    if (grp.name === '👉 手动选择') {
      if (staticGroups) {
        const members = allNodeNames.length > 0 ? allNodeNames : ['direct'];
        addGroupLine(`static=${grp.name}, ${members.join(', ')}`, grp);
      } else {
        addGroupLine(`static=${grp.name}, server-tag-regex=.*`, grp);
      }
      return;
    }

    const cleanName = cleanSourceOrGroupName(grp.name).toLowerCase();

    // 优先匹配 Filter 筛选源（例如 ✨ HK优选、✨ AI选择）：
    // Filter 源的节点已由 Subone 计算完成，直接注入到策略组中
    const matchedFilterSource = sources.find(s =>
      s.enabled && s.type === 'filter' && (
        grp.id === `grp-src-${s.id}` ||
        cleanSourceOrGroupName(s.name).toLowerCase() === cleanName ||
        s.id.toLowerCase() === cleanName ||
        (grp.use && grp.use.some(u => cleanSourceOrGroupName(u).toLowerCase() === cleanSourceOrGroupName(s.name).toLowerCase()))
      )
    );

    if (matchedFilterSource) {
      const filterNodeNames = (matchedFilterSource.nodes || [])
        .filter(isSupportedByQuantumultX)
        .map(n => n.name.replace(/[=,]/g, '_'));

      if (filterNodeNames.length > 0) {
        if (grp.type === 'select') {
          addGroupLine(`static=${grp.name}, ${[...filterNodeNames, 'direct'].join(', ')}`, grp);
        } else if (grp.type === 'urltest') {
          addGroupLine(`url-latency-benchmark=${grp.name}, ${filterNodeNames.join(', ')}, check-interval=300, tolerance=${grp.tolerance || 50}`, grp);
        } else if (grp.type === 'fallback') {
          addGroupLine(`available=${grp.name}, ${[...filterNodeNames, 'direct'].join(', ')}`, grp);
        } else if (grp.type === 'load-balance') {
          addGroupLine(policyWithMembers(groupType, grp, filterNodeNames), grp);
        } else {
          addGroupLine(`static=${grp.name}, ${[...filterNodeNames, 'direct'].join(', ')}`, grp);
        }
      } else {
        addGroupLine(`static=${grp.name}, direct`, grp);
      }
      return;
    }

    // 匹配物理远程订阅源（外部机场订阅 / 内部独立节点组）
    const matchedRemote = allActiveRemoteSources.find(s => {
      const sClean = cleanSourceOrGroupName(s.name).toLowerCase();
      return sClean === cleanName || s.id.toLowerCase() === cleanName ||
        (grp.use && grp.use.some(u => cleanSourceOrGroupName(u).toLowerCase() === sClean));
    });

    if (matchedRemote && !staticGroups) {
      const sTag = matchedRemote.name.replace(/[=,]/g, '_').trim();
      if (groupType === 'url-latency-benchmark') {
        addGroupLine(`url-latency-benchmark=${grp.name}, resource-tag-regex=^${sTag}$, check-interval=300, tolerance=${grp.tolerance || 50}`, grp);
      } else if (groupType === 'static') {
        addGroupLine(`static=${grp.name}, resource-tag-regex=^${sTag}$`, grp);
      } else {
        addGroupLine(`${groupType}=${grp.name}, resource-tag-regex=^${sTag}$`, grp);
      }
      return;
    }

    if (!hasSuboneRemoteSubscription) {
      const isCustomGrp = grp.id === 'grp-src-custom' ||
        cleanName === '自建节点' ||
        cleanName === '独立节点组' ||
        cleanName === 'custom' ||
        cleanName === '手工自建' ||
        customSources.some(cs => cleanSourceOrGroupName(cs.name).toLowerCase() === cleanName);

      if (isCustomGrp) {
        const members = customNodeNames.length > 0 ? customNodeNames : ['direct'];
        addGroupLine(`static=${grp.name}, ${members.join(', ')}`, grp);
        return;
      }
    }

    // Standard selector group
    let proxies = grp.proxies ? [...grp.proxies] : [];

    if (!hasSuboneRemoteSubscription && grp.name === '🚀 节点选择' && customNodes.length > 0 && !proxies.includes(customTagName)) {
      proxies.unshift(customTagName);
    }

    if (grp.use && grp.use.length > 0) {
      grp.use.forEach(u => {
        const cleanU = cleanSourceOrGroupName(u).toLowerCase();
        const matchedSource = sources.find(s => {
          const sClean = cleanSourceOrGroupName(s.name).toLowerCase();
          return sClean === cleanU || s.id.trim().toLowerCase() === cleanU;
        });

        if (matchedSource) {
          const targetGrp = effectiveGroups.find(g => {
            const gClean = cleanSourceOrGroupName(g.name).toLowerCase();
            return g.id === `grp-src-${matchedSource.id}` ||
                   (matchedSource.id === 'custom' && g.id === 'grp-src-custom') ||
                   gClean === cleanU;
          });
          if (targetGrp && targetGrp.name !== grp.name && !proxies.includes(targetGrp.name)) {
            proxies.push(targetGrp.name);
          } else if (!targetGrp && matchedSource.nodes && matchedSource.nodes.length > 0) {
            matchedSource.nodes.forEach(m => {
              const nodeTag = m.name.replace(/[=,]/g, '_');
              if (!proxies.includes(nodeTag)) proxies.push(nodeTag);
            });
          }
        }
      });
    }

    proxies = proxies.map(p => {
      const u = p.trim().toUpperCase();
      if (u === 'DIRECT' || p.trim() === '🎯 本地直连') return 'direct';
      if (u === 'REJECT') return 'reject';
      return p.trim();
    }).filter(p => {
      if (!p || p === grp.name) return false;
      return validGroupNames.has(p) || validNodeNames.has(p) || p === 'direct' || p === 'reject';
    });

    proxies = Array.from(new Set(proxies));

    if (proxies.length === 0) proxies = ['direct'];

    addGroupLine(policyWithMembers(groupType, grp, proxies), grp);
  });

  // 3. Build [filter_remote]
  const availableGroupNames = new Set([...nativeNames, ...allNodeNames, ...effectiveGroups.map(g => g.name)]);
  const fallbackGroup = effectiveGroups.find(g => g.name === '🚀 节点选择')?.name || effectiveGroups[0]?.name || 'direct';

  const remoteRuleLines: string[] = [];
  const seenRemoteUrls = new Set<string>();

  remoteRules.forEach((r, idx) => {
    const adapted = r.behavior === 'classical' && options?.baseUrl && options?.subToken
      ? { tag: formatRuleTag(r, idx), url: `${options.baseUrl}/s/${encodeURIComponent(options.subToken)}/rules/${encodeURIComponent(r.id)}/qx` }
      : adaptRulesetForQuantumultX(r, idx);
    const targetGroup = resolveSafeOutbound(r.outbound, availableGroupNames, fallbackGroup);
    const out = targetGroup === '🎯 本地直连' || targetGroup.toUpperCase() === 'DIRECT'
      ? 'direct'
      : (targetGroup.toUpperCase() === 'REJECT' || targetGroup === '🛑 REJECT' || targetGroup === '🛑 广告拦截' ? 'reject' : targetGroup);

    const cleanUrl = (adapted.url || '').trim();
    if (!cleanUrl || seenRemoteUrls.has(cleanUrl)) {
      return;
    }
    seenRemoteUrls.add(cleanUrl);

    remoteRuleLines.push(`${cleanUrl}, tag=${adapted.tag}, force-policy=${out}, update-interval=86400, opt-parser=false, enabled=true`);
  });

  // 4. Build [filter_local]
  const localRuleLines: string[] = [];
  localRules.forEach(r => {
    const targetGroup = resolveSafeOutbound(r.outbound, availableGroupNames, fallbackGroup);
    const out = targetGroup === '🎯 本地直连' || targetGroup.toUpperCase() === 'DIRECT'
      ? 'direct'
      : (targetGroup.toUpperCase() === 'REJECT' || targetGroup === '🛑 REJECT' || targetGroup === '🛑 广告拦截' ? 'reject' : targetGroup);

    const payloads = (r.payload || '').split(/[,;\n]+/).map(p => p.trim()).filter(Boolean);
    payloads.forEach(p => {
      let qxRuleType = 'host-suffix';
      let formattedPayload = p;

      if (r.type === 'DOMAIN') {
        qxRuleType = 'host';
      } else if (r.type === 'DOMAIN-SUFFIX') {
        qxRuleType = 'host-suffix';
      } else if (r.type === 'DOMAIN-KEYWORD') {
        qxRuleType = 'host-keyword';
      } else if (r.type === 'IP-CIDR' || r.type === 'SRC-IP-CIDR') {
        formattedPayload = formatCidr(p);
        qxRuleType = formattedPayload.includes(':') ? 'ip6-cidr' : 'ip-cidr';
      } else if (r.type === 'GEOIP') {
        qxRuleType = 'geoip';
        formattedPayload = p.toLowerCase();
      }

      localRuleLines.push(`${qxRuleType}, ${formattedPayload}, ${out}${r.noResolve ? ', no-resolve' : ''}`);
    });
  });

  const finalRule = activeRules.find(r => r.type === 'FINAL');
  const rawFinalTarget = finalRule
    ? resolveSafeOutbound(finalRule.outbound, availableGroupNames, fallbackGroup)
    : (availableGroupNames.has('🐟 漏网之鱼') ? '🐟 漏网之鱼' : fallbackGroup);
  const finalOut = rawFinalTarget === '🎯 本地直连' || rawFinalTarget.toUpperCase() === 'DIRECT'
    ? 'direct'
    : (rawFinalTarget.toUpperCase() === 'REJECT' ? 'reject' : rawFinalTarget);
  const nativeFinal = quantumultXEntries({ quantumultxLines: lines }).find(entry => entry.section === 'filter_local' && /^final\s*(?:=|$)/i.test(entry.parts[0].trim()));
  const finalLine = !finalRule && nativeFinal ? lines[nativeFinal.index] : `final, ${finalOut}`;

  // 5. Assemble config
  const result: string[] = [];
  let hasHandledServerRemote = false;
  let hasHandledPolicy = false;
  let hasHandledFilterRemote = false;
  let hasHandledFilterLocal = false;

  let inFilterLocal = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim().toLowerCase();
    if (trimmed.startsWith('[') && inFilterLocal) { result.push(finalLine); inFilterLocal = false; }

    // Ignore hardcoded final lines from template to prevent duplicate final entries
    if (trimmed.startsWith('final=') || trimmed.startsWith('final,') || trimmed === 'final') {
      continue;
    }

    if (trimmed === '[server_remote]') {
      hasHandledServerRemote = true;
      result.push(line);
      result.push(...serverRemoteLines);
      continue;
    }

    if (trimmed === '[policy]') {
      hasHandledPolicy = true;
      result.push(line);
      result.push(...groupLines);
      continue;
    }

    if (trimmed === '[filter_remote]') {
      hasHandledFilterRemote = true;
      result.push(line);
      result.push(...remoteRuleLines);
      continue;
    }

    if (trimmed === '[filter_local]') {
      hasHandledFilterLocal = true; inFilterLocal = true;
      result.push(line);
      result.push(...localRuleLines);
      continue;
    }

    result.push(line);
  }

  if (inFilterLocal) result.push(finalLine);
  if (!hasHandledServerRemote) {
    result.push('\n[server_remote]');
    if (serverRemoteLines.length > 0) result.push(...serverRemoteLines);
  }
  if (!hasHandledPolicy) {
    result.push('\n[policy]');
    if (groupLines.length > 0) result.push(...groupLines);
  }
  if (!hasHandledFilterRemote) {
    result.push('\n[filter_remote]');
    if (remoteRuleLines.length > 0) result.push(...remoteRuleLines);
  }
  if (!hasHandledFilterLocal) {
    result.push('\n[filter_local]');
    if (localRuleLines.length > 0) result.push(...localRuleLines);
    result.push(finalLine);
  }

  // Ensure mandatory Quantumult X sections exist to prevent "配置文件缺少模块" errors
  let output = result.join('\n');
  const mandatorySections = [
    { header: '[server_local]', content: '' },
    { header: '[server_remote]', content: '' },
    { header: '[filter_local]', content: '' },
    { header: '[filter_remote]', content: '' },
    { header: '[rewrite_remote]', content: '' },
    { header: '[rewrite_local]', content: '' },
    { header: '[mitm]', content: 'hostname =' },
  ];

  for (const sec of mandatorySections) {
    if (!output.toLowerCase().includes(sec.header)) {
      output += `\n\n${sec.header}\n${sec.content ? sec.content + '\n' : ''}`;
    }
  }

  return output.trim() + '\n';
}
