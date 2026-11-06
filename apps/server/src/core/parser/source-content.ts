import yaml from 'js-yaml';
import type { CountryPatternRule, ProxyNode, SourceFormat } from '../../types';
import { parseClashYaml } from './clash-parser';
import { parseSingboxJson } from './singbox-parser';
import { isQuantumultXContent, parseQuantumultX } from './quantumultx-parser';
import { parseRawContent } from './fetcher';

export interface ParsedSourceContent {
  nodes: ProxyNode[];
  format: SourceFormat;
  document?: Record<string, unknown>;
}
export class ContentParseError extends Error {
  constructor(message: string, public format?: SourceFormat) { super(message); }
}
const nodeTypes = new Set(['ss', 'ssr', 'vmess', 'vless', 'trojan', 'hysteria', 'hysteria2', 'tuic', 'wireguard', 'snell', 'anytls', 'naive', 'shadowtls', 'http', 'socks5']);
function validateNode(node: ProxyNode): void {
  const fail = () => { throw new Error(`节点「${node.name}」解析不完整`); };
  if (!nodeTypes.has(node.type) || !node.server || !Number.isInteger(node.port) || node.port < 1 || node.port > 65535) fail();
  if ((node.type === 'ss' || node.type === 'ssr') && (!node.method || (!node.password && node.method !== 'none'))) fail();
  if ((node.type === 'vmess' || node.type === 'vless') && !node.uuid) fail();
  if (['trojan', 'hysteria2', 'anytls', 'shadowtls', 'naive'].includes(node.type) && !node.password) fail();
  if (node.type === 'tuic' && (!node.uuid || !node.password)) fail();
  if (node.type === 'wireguard' && (!node.privateKey || !node.publicKey)) fail();
  if (node.type === 'snell' && !node.psk) fail();
}

/** Parse the complete response. Never publish a partially parsed collection. */
export function parseSourceContent(raw: string, sourceId: string, sourceName: string, countryPatterns?: CountryPatternRule[]): ParsedSourceContent {
  const content = raw.trim();
  let format: SourceFormat | undefined;
  try {
    if (!content) throw new Error('订阅正文为空');
    if (content.startsWith('{')) {
      if (/"(?:outbounds|dns)"\s*:/.test(content)) format = 'singbox';
      const document = JSON.parse(content);
      if (!document || typeof document !== 'object' || (!Array.isArray(document.outbounds) && !document.dns)) throw new Error('无法识别订阅格式');
      if (document.outbounds !== undefined && !Array.isArray(document.outbounds)) throw new Error('sing-box 节点列表无效');
      const nodes = parseSingboxJson(content, sourceId, sourceName, countryPatterns);
      const targets = (document.outbounds || []).filter((item: any) => !['selector', 'urltest', 'direct', 'block', 'dns'].includes(item?.type));
      if (nodes.length !== targets.length) throw new Error('sing-box 节点解析不完整');
      nodes.forEach(validateNode);
      return { nodes, format: 'singbox', document };
    }
    if (/(?:^|\n)\s*(?:proxies|dns|proxy-groups):/.test(content)) {
      format = 'mihomo';
      const document = yaml.load(content) as any;
      if (!document || typeof document !== 'object' || (!Array.isArray(document.proxies) && !document.dns)) throw new Error('Mihomo 节点列表无效');
      if (document.proxies !== undefined && !Array.isArray(document.proxies)) throw new Error('Mihomo 节点列表无效');
      const nodes = parseClashYaml(content, sourceId, sourceName, countryPatterns);
      if (nodes.length !== (document.proxies || []).length) throw new Error('Mihomo 节点解析不完整');
      nodes.forEach(validateNode);
      return { nodes, format, document };
    }
    if (isQuantumultXContent(content) || /^\[dns\]/mi.test(content)) {
      format = 'quantumultx';
      const nodes = parseQuantumultX(content, sourceId, sourceName, countryPatterns);
      let section = '';
      const hasSections = /^\s*\[[\w-]+\]/m.test(content);
      const targets = content.split(/[\r\n]+/).filter(rawLine => {
        const line = rawLine.trim();
        if (!line || /^(#|;|\/\/)/.test(line)) return false;
        const header = /^\[\s*([\w-]+)\s*\]/.exec(line);
        if (header) { section = header[1].toLowerCase(); return false; }
        return !hasSections || section === 'server_local';
      });
      if (nodes.length !== targets.length) throw new Error('QuanX 节点解析不完整');
      nodes.forEach(validateNode);
      return { nodes, format };
    }
    const compact = content.replace(/\s/g, '');
    if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(compact)) {
      const decoded = Buffer.from(compact.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
      if (decoded !== content && !decoded.includes('\uFFFD')) {
        const parsed = parseSourceContent(decoded, sourceId, sourceName, countryPatterns);
        return { ...parsed, format: parsed.format === 'uri' ? 'base64' : parsed.format };
      }
    }
    const lines = content.split(/[\r\n]+/).map(line => line.trim()).filter(line => line && !/^(#|;|\/\/)/.test(line));
    const nodes = parseRawContent(lines.join('\n'), sourceId, sourceName, undefined, countryPatterns);
    if (nodes.length || lines.some(line => /^[a-z][\w+-]*:\/\//i.test(line))) format = 'uri';
    if (!nodes.length || nodes.length !== lines.length) throw new Error('无法识别订阅格式或节点解析不完整');
    nodes.forEach(validateNode);
    return { nodes, format: 'uri' };
  } catch (error) {
    if (error instanceof ContentParseError) throw error;
    throw new ContentParseError(error instanceof Error ? error.message : '订阅解析失败', format);
  }
}
