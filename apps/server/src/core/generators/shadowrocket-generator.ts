import { ProxyNode, UnifiedRuleItem, SubscriptionSource } from '../../types/index';
import { adaptRulesetForShadowrocket } from './ruleset-adapter';
import { formatCidr } from './common';
import { resolveGroupNodes, type OutputGroup } from './group-nodes';

export function nodeToShadowrocketProxy(node: ProxyNode): string {
  const name = node.name.replace(/[=,]/g, '_');
  const cleanServer = (node.server || '').trim().replace(/^\[(.*)\]$/, '$1');

  if (node.type === 'ss') {
    const cipher = node.method || 'aes-128-gcm';
    const pwd = node.password || '';
    let line = `${name} = ss, ${cleanServer}, ${node.port}, ${cipher}, "${pwd}"`;
    if (node.reality?.enabled && node.reality.publicKey) {
      line += `, reality=true, public-key=${node.reality.publicKey}`;
      if (node.reality.shortId) line += `, short-id=${node.reality.shortId}`;
      if (node.sni) line += `, sni=${node.sni}`;
    } else if (node.plugin === 'obfs') {
      line += `, obfs=${node.pluginOpts?.mode || 'http'}, obfs-host=${node.pluginOpts?.host || ''}`;
    } else if (node.plugin === 'v2ray-plugin') {
      line += `, v2ray-plugin=true, plugin-opts="mode=${node.pluginOpts?.mode || 'websocket'};host=${node.pluginOpts?.host || ''};path=${node.pluginOpts?.path || '/'}"`;
    }
    line += `, udp=true, fast-open=false`;
    return line;
  }

  if (node.type === 'vmess') {
    const cipher = node.cipher || 'auto';
    let line = `${name} = vmess, ${cleanServer}, ${node.port}, username=${node.uuid || ''}, alterId=${node.alterId || 0}, cipher=${cipher}`;
    if (node.network === 'ws') {
      line += `, ws=true, ws-path=${node.wsPath || '/'}`;
      const host = node.wsHeaders?.Host || node.wsHeaders?.host || node.sni;
      if (host) line += `, ws-headers=Host:${host}`;
    }
    if (node.tls) {
      line += `, tls=true`;
      if (node.sni) line += `, sni=${node.sni}`;
      if (node.skipCertVerify) line += `, skip-cert-verify=true`;
    }
    if (node.reality?.enabled && node.reality.publicKey) {
      line += `, reality=true, public-key=${node.reality.publicKey}`;
      if (node.reality.shortId) line += `, short-id=${node.reality.shortId}`;
    }
    line += `, udp=true, fast-open=false`;
    return line;
  }

  if (node.type === 'vless') {
    let line = `${name} = vless, ${cleanServer}, ${node.port}, username=${node.uuid || ''}`;
    const net = (node.network || 'tcp').toLowerCase();

    if (net === 'ws') {
      line += `, ws=true, ws-path=${node.wsPath || '/'}`;
      const host = node.wsHeaders?.Host || node.wsHeaders?.host || node.sni;
      if (host) line += `, ws-headers=Host:${host}`;
    } else if (net === 'grpc') {
      line += `, grpc=true`;
      if (node.grpcServiceName) line += `, grpc-service-name=${node.grpcServiceName}`;
    } else if (net === 'http' || net === 'h2') {
      line += `, http=true, path=${node.h2Path || '/'}`;
      const host = node.h2Host || node.sni;
      if (host) line += `, host=${host}`;
    }

    if (node.tls || node.reality?.enabled) {
      line += `, tls=true`;
      if (node.sni) line += `, sni=${node.sni}`;
      if (node.skipCertVerify) line += `, skip-cert-verify=true`;
      if (node.fingerprint) line += `, client-fingerprint=${node.fingerprint}`;
    }

    if (node.reality?.enabled && node.reality.publicKey) {
      line += `, reality=true, public-key=${node.reality.publicKey}`;
      if (node.reality.shortId) line += `, short-id=${node.reality.shortId}`;
    }

    if (node.flow?.includes('vision')) {
      line += `, flow=xtls-rprx-vision`;
    }

    line += `, udp=true, fast-open=false`;
    return line;
  }

  if (node.type === 'trojan') {
    let line = `${name} = trojan, ${cleanServer}, ${node.port}, password="${node.password || ''}", tls=true`;
    if (node.sni) line += `, sni=${node.sni}`;
    if (node.skipCertVerify) line += `, skip-cert-verify=true`;
    if (node.fingerprint) line += `, client-fingerprint=${node.fingerprint}`;

    if (node.network === 'ws') {
      line += `, ws=true, ws-path=${node.wsPath || '/'}`;
      const host = node.wsHeaders?.Host || node.wsHeaders?.host || node.sni;
      if (host) line += `, ws-headers=Host:${host}`;
    } else if (node.network === 'grpc') {
      line += `, grpc=true`;
      if (node.grpcServiceName) line += `, grpc-service-name=${node.grpcServiceName}`;
    }

    if (node.reality?.enabled && node.reality.publicKey) {
      line += `, reality=true, public-key=${node.reality.publicKey}`;
      if (node.reality.shortId) line += `, short-id=${node.reality.shortId}`;
    }

    line += `, udp=true, fast-open=false`;
    return line;
  }

  if (node.type === 'hysteria2') {
    let line = `${name} = hysteria2, ${cleanServer}, ${node.port}, password="${node.password || ''}"`;
    if (node.sni) line += `, sni=${node.sni}`;
    if (node.skipCertVerify) line += `, skip-cert-verify=true`;
    const obfsPwd = node.obfsPassword || (node.obfs && node.obfs !== 'salamander' ? node.obfs : undefined);
    if (obfsPwd) line += `, obfs=salamander, obfs-password="${obfsPwd}"`;
    if (node.downMbps) line += `, download-bandwidth=${node.downMbps}`;
    if (node.upMbps) line += `, upload-bandwidth=${node.upMbps}`;
    if (node.serverPorts && node.serverPorts.length > 0) {
      const ports = (Array.isArray(node.serverPorts) ? node.serverPorts : String(node.serverPorts).split(','))
        .map((s: any) => String(s).trim().replace(':', '-'))
        .filter(Boolean)
        .join(',');
      if (ports) line += `, mport=${ports}`;
    }
    line += `, udp=true`;
    return line;
  }

  if (node.type === 'anytls') {
    let line = `${name} = anytls, ${cleanServer}, ${node.port}, password="${node.password || ''}", tls=true`;
    if (node.sni) line += `, sni=${node.sni}`;
    if (node.skipCertVerify) line += `, skip-cert-verify=true`;
    if (node.fingerprint) line += `, client-fingerprint=${node.fingerprint}`;
    if (node.reality?.enabled && node.reality.publicKey) {
      line += `, reality=true, public-key=${node.reality.publicKey}`;
      if (node.reality.shortId) line += `, short-id=${node.reality.shortId}`;
    }
    line += `, udp=true`;
    return line;
  }

  if (node.type === 'socks5') {
    let line = `${name} = socks5, ${cleanServer}, ${node.port}`;
    if (node.username || node.password) {
      line += `, auth=${node.username || ''}:${node.password || ''}`;
    }
    if (node.tls) {
      line += `, tls=true`;
      if (node.sni) line += `, sni=${node.sni}`;
    }
    line += `, udp=true`;
    return line;
  }

  if (node.type === 'http') {
    let line = `${name} = http, ${cleanServer}, ${node.port}`;
    if (node.username || node.password) {
      line += `, auth=${node.username || ''}:${node.password || ''}`;
    }
    if (node.tls) {
      line += `, tls=true`;
      if (node.sni) line += `, sni=${node.sni}`;
    }
    line += `, udp=true`;
    return line;
  }

  if (node.type === 'wireguard') {
    let line = `${name} = wireguard, ${cleanServer}, ${node.port}, ip=${node.ip || '10.0.0.2'}, private-key="${node.privateKey || ''}", public-key="${node.publicKey || ''}"`;
    if (node.presharedKey) line += `, preshared-key="${node.presharedKey}"`;
    if (node.reserved && node.reserved.length > 0) line += `, reserved=${node.reserved.join(',')}`;
    return line;
  }

  return `# Unsupported on Shadowrocket (${node.type.toUpperCase()}): ${name}`;
}

export function nodeToUri(node: ProxyNode): string | null {
  const name = encodeURIComponent(node.name);
  const cleanServer = (node.server || '').trim().replace(/^\[(.*)\]$/, '$1');
  const uriHost = cleanServer.includes(':') && !cleanServer.startsWith('[') ? `[${cleanServer}]` : cleanServer;

  if (node.type === 'ss') {
    const cred = Buffer.from(`${node.method || 'aes-128-gcm'}:${node.password || ''}`).toString('base64');
    return `ss://${cred}@${uriHost}:${node.port}#${name}`;
  }

  if (node.type === 'trojan') {
    const params = new URLSearchParams();
    if (node.sni) params.set('sni', node.sni);
    if (node.skipCertVerify) params.set('allowInsecure', '1');
    if (node.network === 'ws') {
      params.set('type', 'ws');
      params.set('path', node.wsPath || '/');
      const host = node.wsHeaders?.Host || node.wsHeaders?.host || node.sni;
      if (host) params.set('host', host);
    } else if (node.network === 'grpc') {
      params.set('type', 'grpc');
      if (node.grpcServiceName) params.set('serviceName', node.grpcServiceName);
    }
    const qs = params.toString();
    return `trojan://${encodeURIComponent(node.password || '')}@${uriHost}:${node.port}${qs ? '?' + qs : ''}#${name}`;
  }

  if (node.type === 'vless') {
    const params = new URLSearchParams();
    if (node.reality?.enabled) {
      params.set('security', 'reality');
      params.set('pbk', node.reality.publicKey);
      if (node.reality.shortId) params.set('sid', node.reality.shortId);
    } else if (node.tls) {
      params.set('security', 'tls');
    }
    if (node.sni) params.set('sni', node.sni);
    if (node.fingerprint) params.set('fp', node.fingerprint);
    if (node.flow) params.set('flow', node.flow);

    const net = (node.network || 'tcp').toLowerCase();
    if (net === 'ws') {
      params.set('type', 'ws');
      params.set('path', node.wsPath || '/');
      const host = node.wsHeaders?.Host || node.wsHeaders?.host || node.sni;
      if (host) params.set('host', host);
    } else if (net === 'grpc') {
      params.set('type', 'grpc');
      if (node.grpcServiceName) params.set('serviceName', node.grpcServiceName);
    } else if (net !== 'tcp') {
      params.set('type', net);
    }
    const qs = params.toString();
    return `vless://${node.uuid || ''}@${uriHost}:${node.port}${qs ? '?' + qs : ''}#${name}`;
  }

  if (node.type === 'hysteria2') {
    const params = new URLSearchParams();
    if (node.sni) params.set('sni', node.sni);
    if (node.skipCertVerify) params.set('insecure', '1');
    const obfsPwd = node.obfsPassword || (node.obfs && node.obfs !== 'salamander' ? node.obfs : undefined);
    if (obfsPwd) {
      params.set('obfs', 'salamander');
      params.set('obfs-password', obfsPwd);
    }
    if (node.serverPorts && node.serverPorts.length > 0) {
      const ports = (Array.isArray(node.serverPorts) ? node.serverPorts : String(node.serverPorts).split(','))
        .map((s: any) => String(s).trim().replace(':', '-'))
        .filter(Boolean)
        .join(',');
      if (ports) params.set('mport', ports);
    }
    const qs = params.toString();
    return `hysteria2://${encodeURIComponent(node.password || '')}@${uriHost}:${node.port}${qs ? '?' + qs : ''}#${name}`;
  }

  if (node.type === 'anytls') {
    const params = new URLSearchParams();
    if (node.sni) params.set('sni', node.sni);
    if (node.skipCertVerify) params.set('insecure', '1');
    if (node.fingerprint) params.set('fp', node.fingerprint);
    const qs = params.toString();
    return `anytls://${encodeURIComponent(node.password || '')}@${uriHost}:${node.port}${qs ? '?' + qs : ''}#${name}`;
  }

  if (node.type === 'vmess') {
    const vmessObj: Record<string, any> = {
      v: '2',
      ps: node.name,
      add: cleanServer,
      port: node.port,
      id: node.uuid || '',
      aid: node.alterId || 0,
      scy: node.cipher || 'auto',
      net: node.network || 'tcp',
      type: 'none',
      host: node.wsHeaders?.Host || node.wsHeaders?.host || node.sni || '',
      path: node.wsPath || '/',
      tls: node.tls ? 'tls' : '',
      sni: node.sni || '',
    };
    const b64 = Buffer.from(JSON.stringify(vmessObj)).toString('base64');
    return `vmess://${b64}`;
  }

  return null;
}

export function generateShadowrocketBase64(nodes: ProxyNode[]): string {
  const uris = nodes
    .map(nodeToUri)
    .filter((u): u is string => Boolean(u));
  return Buffer.from(uris.join('\n'), 'utf-8').toString('base64');
}

interface ShadowrocketGeneratorOptions {
  expandNodes?: boolean;
  ordinaryNodeIds?: ReadonlySet<string>;
  dependencyGroupIds?: ReadonlySet<string>;
  runtimeSources?: SubscriptionSource[];
}

/** Append managed declarations without replacing native template definitions. */
function appendIniSection(content: string, section: string, additions: string[]): string {
  const lines = content.split('\n');
  const index = lines.findIndex(line => line.trim().toLowerCase() === `[${section.toLowerCase()}]`);
  if (index >= 0) lines.splice(index + 1, 0, ...additions);
  else lines.push('', `[${section}]`, ...additions);
  return lines.join('\n');
}

export function generateShadowrocketConfig(
  templateConf: string,
  nodes: ProxyNode[],
  proxyGroups: OutputGroup[] = [],
  rulesList: UnifiedRuleItem[] = [],
  sources: SubscriptionSource[] = [],
  options?: ShadowrocketGeneratorOptions,
): string {
  // This complete INI path carries concrete declarations. No unverified remote syntax is invented.
  const content = appendIniSection(templateConf, 'Proxy', nodes.map(nodeToShadowrocketProxy));
  return injectUnifiedToShadowrocket(content, nodes, proxyGroups, rulesList, sources, options);
}

export function injectUnifiedToShadowrocket(
  templateConf: string,
  nodes: ProxyNode[],
  proxyGroups: OutputGroup[],
  rulesList: UnifiedRuleItem[],
  sources: SubscriptionSource[] = [],
  options?: ShadowrocketGeneratorOptions,
): string {
  const ordinary = nodes.filter(node => !options?.ordinaryNodeIds || options.ordinaryNodeIds.has(node.id));
  const groupLines = proxyGroups.map(group => {
    if (group.type === 'direct' || group.type === 'reject') return `${group.name} = select, ${group.type.toUpperCase()}`;
    const members = [...(group.proxies || [])].map(member => member === '🎯 本地直连' ? 'DIRECT' : member);
    const mounts = group.sources ?? group.use;
    if (!group.membersResolved && group.type !== 'relay' && (mounts?.length || group.filter || !members.length)) {
      for (const node of resolveGroupNodes(group, ordinary, options?.runtimeSources || sources)) if (!members.includes(node.name)) members.push(node.name);
    }
    if (!members.length && !group.proxies?.length && !mounts?.length && !group.filter && !group.includeAll) members.push('DIRECT');
    const type = group.type === 'urltest' ? 'url-test' : group.type;
    const probe = ['url-test', 'fallback', 'load-balance'].includes(type)
      ? `, url=${group.url || 'http://cp.cloudflare.com/generate_204'}, interval=${group.interval || 300}${type === 'url-test' ? `, tolerance=${group.tolerance || 50}` : ''}` : '';
    const balanceOptions = type === 'load-balance'
      ? `${group.strategy ? `, strategy=${group.strategy}` : ''}${group.lazy !== undefined ? `, lazy=${group.lazy}` : ''}` : '';
    return `${group.name} = ${type}${members.length ? ', ' + members.join(', ') : ''}${probe}${balanceOptions}`;
  });
  const active = rulesList.filter(rule => rule.enabled);
  const ruleLines: string[] = [];
  const outbound = (value: string) => value === '🎯 本地直连' ? 'DIRECT' : value;
  for (const [index, rule] of active.entries()) {
    if (rule.kind === 'remote') {
      ruleLines.push(`RULE-SET,${adaptRulesetForShadowrocket(rule, index).url},${outbound(rule.outbound)}`);
    } else if (rule.type !== 'FINAL') {
      for (const payload of rule.payload.split(/[,;\n]+/).map(value => value.trim()).filter(Boolean)) {
        const cidr = rule.type === 'SRC-IP-CIDR' ? formatCidr(payload) : payload;
        ruleLines.push(`${rule.type},${cidr},${outbound(rule.outbound)}${['IP-CIDR', 'SRC-IP-CIDR'].includes(rule.type) ? ',no-resolve' : ''}`);
      }
    }
  }
  let section = ''; let nativeFinal: string | undefined;
  const lines = templateConf.split('\n').filter(line => {
    const header = /^\s*\[([^\]]+)\]/.exec(line);
    if (header) section = header[1].toLowerCase();
    if (section === 'rule' && /^\s*FINAL\s*,/i.test(line)) { nativeFinal ??= line; return false; }
    return true;
  });
  const managedFinal = active.find(rule => rule.type === 'FINAL');
  const fallback = proxyGroups.find(group => group.name === '🐟 漏网之鱼')?.name || proxyGroups[0]?.name || 'DIRECT';
  const finalLine = managedFinal ? `FINAL,${outbound(managedFinal.outbound)}` : nativeFinal || `FINAL,${fallback}`;
  let content = appendIniSection(lines.join('\n'), 'Proxy Group', groupLines);
  content = appendIniSection(content, 'Rule', ruleLines);
  // FINAL must follow every native and managed rule in this section.
  const result = content.split('\n');
  const start = result.findIndex(line => line.trim().toLowerCase() === '[rule]');
  const end = result.findIndex((line, index) => index > start && /^\s*\[/.test(line));
  result.splice(end < 0 ? result.length : end, 0, finalLine);
  return result.join('\n');
}
