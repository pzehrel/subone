import crypto from 'node:crypto';
import { isIP } from 'node:net';
import type { CountryPatternRule, ProxyNode, ProxyType } from '../../types/index';
import { detectCountry } from './country';
import { parseNodeUri } from './uri-parser';

// Native resource syntax: https://github.com/crossutility/Quantumult-X/blob/master/sample.conf
const NODE_PREFIX = /^(shadowsocks|vmess|vless|trojan|http|socks5|anytls)\s*=/i;
const SECTION = /^\[\s*([\w-]+)\s*\](?:\s*(?:#|;|\/\/).*)?$/;
const COMMENT = /^(?:#|;|\/\/)/;

export function isQuantumultXContent(content: string): boolean {
  return content.split(/[\r\n]+/).some(raw => {
    const line = raw.trim();
    return NODE_PREFIX.test(line) || SECTION.exec(line)?.[1].toLowerCase() === 'server_local';
  });
}

function splitFields(line: string): string[] | null {
  const fields: string[] = [];
  let field = '';
  let quote = '';
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    const next = line[index + 1];
    if (char === '\\' && (next === ',' || next === '\\' || next === quote)) {
      field += char + next;
      index++;
      continue;
    }
    if (quote) {
      if (char === quote) quote = '';
    } else if ((char === '"' || char === "'") && field.slice(field.indexOf('=') + 1).trim() === '') {
      quote = char;
    } else if (char === ',') {
      fields.push(field.trim());
      field = '';
      continue;
    }
    field += char;
  }
  if (quote) return null;
  fields.push(field.trim());
  return fields;
}

function readValue(raw: string): string {
  const value = raw.trim();
  const quoted = (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"));
  return (quoted ? value.slice(1, -1) : value).replace(/\\([\\,"'])/g, '$1');
}

function readBoolean(value: string | undefined): boolean | undefined {
  if (value?.toLowerCase() === 'true') return true;
  if (value?.toLowerCase() === 'false') return false;
  return undefined;
}

function readAlpn(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const hex = value.replace(/:/g, '');
  if (!/^(?:[\da-f]{2})+$/i.test(hex)) return undefined;
  const buffer = Buffer.from(hex, 'hex');
  const protocols: string[] = [];
  for (let offset = 0; offset < buffer.length;) {
    const length = buffer[offset++];
    if (length === 0 || offset + length > buffer.length) return undefined;
    protocols.push(buffer.toString('utf8', offset, offset + length));
    offset += length;
  }
  return protocols.length ? protocols : undefined;
}

function parseNativeNode(
  line: string,
  index: number,
  sourceId?: string,
  sourceName?: string,
  countryPatterns?: CountryPatternRule[],
): ProxyNode | null {
  if (!NODE_PREFIX.test(line)) return null;
  const fields = splitFields(line);
  if (!fields) return null;
  const firstEquals = fields[0].indexOf('=');
  const protocol = fields[0].slice(0, firstEquals).trim().toLowerCase();
  const endpoint = readValue(fields[0].slice(firstEquals + 1));
  const address = /^(?:\[([^\]]+)\]|([^:\s\/\[\]?#]+)):(\d+)$/.exec(endpoint);
  if (!address || (address[1] && isIP(address[1]) !== 6)) return null;
  const server = address[1] || address[2];
  const port = Number(address[3]);
  if (!server || port < 1 || port > 65535) return null;
  const options = new Map<string, string>();
  for (const field of fields.slice(1)) {
    const equals = field.indexOf('=');
    if (equals < 1) continue;
    options.set(field.slice(0, equals).trim().toLowerCase(), readValue(field.slice(equals + 1)));
  }
  const password = options.get('password');
  const method = options.get('method')?.toLowerCase();
  let type: ProxyType = protocol === 'shadowsocks' ? 'ss' : protocol as ProxyType;
  if (type === 'ss' && options.get('ssr-protocol')) type = 'ssr';
  if ((type === 'ss' || type === 'ssr') && (!method || (!password && method !== 'none'))) return null;
  if (['vmess', 'vless', 'trojan', 'anytls'].includes(type) && !password) return null;

  const name = options.get('tag') || `${type.toUpperCase()} ${server}:${port}`;
  const country = detectCountry(name, countryPatterns);
  const hash = crypto.createHash('sha256').update(JSON.stringify([sourceId, type, server, port, [...options].sort(), index])).digest('hex').slice(0, 16);
  const node: ProxyNode = {
    id: `qx-${hash}`, name, type, server, port, sourceId, sourceName,
    countryCode: country?.code, countryEmoji: country?.emoji, raw: line,
  };
  if (type === 'vmess' || type === 'vless') {
    node.uuid = password;
    if (type === 'vmess') {
      node.cipher = method === 'chacha20-ietf-poly1305' ? 'chacha20-poly1305' : method || 'auto';
      if (readBoolean(options.get('aead')) !== false) node.alterId = 0;
    }
  } else {
    node.username = options.get('username');
    node.password = password;
    if (type === 'ss' || type === 'ssr') node.method = method;
  }

  const obfs = options.get('obfs')?.toLowerCase();
  const host = options.get('obfs-host');
  const path = options.get('obfs-uri') || '/';
  const realityKey = options.get('reality-base64-pubkey');
  node.tls = type === 'trojan' || type === 'anytls' || readBoolean(options.get('over-tls')) === true || readBoolean(options.get('tls')) === true || obfs === 'over-tls' || obfs === 'wss' || !!realityKey;
  if (node.tls) {
    node.sni = options.get('tls-host') || host;
    const verification = readBoolean(options.get('tls-verification'));
    if (verification !== undefined) node.skipCertVerify = !verification;
    node.alpn = readAlpn(options.get('tls-alpn'));
    const pin = options.get('tls-pubkey-sha256')?.replace(/:/g, '');
    if (pin && /^[\da-f]{64}$/i.test(pin)) node.certificatePublicKeySha256 = [Buffer.from(pin, 'hex').toString('base64')];
  }
  if (realityKey) {
    node.tls = true;
    node.sni = options.get('tls-host') || host;
    node.reality = { enabled: true, publicKey: realityKey, shortId: options.get('reality-hex-shortid') || undefined };
  }
  if (type === 'vless') node.flow = options.get('vless-flow');
  node.udp = readBoolean(options.get('udp-relay'));
  const udpOverTcp = options.get('udp-over-tcp');
  if (udpOverTcp !== undefined) {
    node.udpOverTcp = readBoolean(udpOverTcp) ?? (/^sp\.v[12]$/i.test(udpOverTcp) ? true : undefined);
  }

  if (type === 'ssr') {
    node.protocol = options.get('ssr-protocol');
    node.protocolParam = options.get('ssr-protocol-param');
    node.obfs = obfs;
    node.obfsParam = host;
  } else if (obfs === 'ws' || obfs === 'wss') {
    node.network = 'ws';
    node.wsPath = path;
    node.wsHeaders = { Host: host || node.sni || server };
    if (type === 'ss') {
      node.plugin = 'v2ray-plugin';
      node.pluginOpts = { mode: 'websocket', host: host || server, path, tls: obfs === 'wss' };
    }
  } else if (type === 'ss' && (obfs === 'http' || obfs === 'tls' || obfs === 'shadowsocks-http')) {
    node.plugin = 'obfs';
    node.pluginOpts = { mode: obfs === 'shadowsocks-http' ? 'http' : obfs, host: host || server };
  } else if (obfs === 'http' || obfs === 'vmess-http' || obfs === 'shadowsocks-http') {
    node.network = 'http';
    node.wsPath = path;
    if (host) node.wsHeaders = { Host: host };
  }
  return node;
}

export function parseQuantumultX(
  content: string,
  sourceId?: string,
  sourceName?: string,
  countryPatterns?: CountryPatternRule[],
): ProxyNode[] {
  const lines = content.split(/[\r\n]+/).map(line => line.trim());
  const hasSections = lines.some(line => SECTION.test(line));
  const nodes: ProxyNode[] = [];
  let section = '';
  for (const line of lines) {
    if (!line || COMMENT.test(line)) continue;
    const header = SECTION.exec(line);
    if (header) { section = header[1].toLowerCase(); continue; }
    if (hasSections && section !== 'server_local') continue;
    const node = parseNativeNode(line, nodes.length, sourceId, sourceName, countryPatterns)
      || (/^[\w+-]+:\/\//.test(line) ? parseNodeUri(line, nodes.length, countryPatterns) : null);
    if (!node || !node.server || !Number.isInteger(node.port) || node.port < 1 || node.port > 65535) continue;
    node.sourceId = sourceId;
    node.sourceName = sourceName;
    node.raw = line;
    nodes.push(node);
  }
  return nodes;
}
