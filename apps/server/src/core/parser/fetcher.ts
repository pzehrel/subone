import { CountryPatternRule, ProxyNode, SubscriptionSource } from '../../types/index';
import { parseNodeUri } from './uri-parser';
import { parseClashYaml } from './clash-parser';
import { parseSingboxJson } from './singbox-parser';
import { applySubscriptionInfo } from './subscription-info';

function decodeBase64Safe(str: string): string {
  try {
    let base = str.trim().replace(/-/g, '+').replace(/_/g, '/');
    while (base.length % 4) {
      base += '=';
    }
    return Buffer.from(base, 'base64').toString('utf-8');
  } catch (e) {
    return str;
  }
}

export async function fetchAndParseSource(
  source: SubscriptionSource,
  countryPatterns?: CountryPatternRule[]
): Promise<ProxyNode[]> {
  const url = (source.url || '').trim();
  if (!url) return source.nodes || [];

  // If local direct text content / node URIs (not starting with http/https)
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return applySubscriptionInfo(source, parseRawContent(url, source.id, source.name, source.type, countryPatterns), null);
  }

  try {
    const userAgent = source.customUserAgent || 'ClashMeta/v1.18.0 (subone-engine; +https://github.com/subone)';
    const response = await fetch(url, {
      headers: {
        'User-Agent': userAgent,
        'Accept': '*/*',
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      let detail = '';
      try {
        const errText = await response.text();
        if (errText) {
          try {
            const errJson = JSON.parse(errText);
            detail = ` (${errJson.error || errJson.message || errText.slice(0, 150)})`;
          } catch {
            detail = ` (${errText.slice(0, 150).trim()})`;
          }
        }
      } catch {}
      throw new Error(`HTTP error ${response.status}: ${response.statusText}${detail}`);
    }

    const text = await response.text();
    const nodes = parseRawContent(text, source.id, source.name, source.type, countryPatterns);
    return applySubscriptionInfo(source, nodes, response.headers.get('subscription-userinfo'));
  } catch (err: any) {
    console.error(`Failed to fetch source [${source.name}] (${url}):`, err.message || err);
    throw err;
  }
}

export function parseRawContent(
  raw: string,
  sourceId?: string,
  sourceName?: string,
  hintType?: string,
  countryPatterns?: CountryPatternRule[]
): ProxyNode[] {
  const content = raw.trim();
  if (!content) return [];

  // 1. If explicit or looks like Sing-box JSON
  if (hintType === 'singbox' || (content.startsWith('{') && content.endsWith('}') && content.includes('"outbounds"'))) {
    const nodes = parseSingboxJson(content, sourceId, sourceName, countryPatterns);
    if (nodes.length > 0) return nodes;
  }

  // 2. If explicit or looks like Clash YAML
  if (hintType === 'clash' || content.includes('proxies:') || content.includes('proxy-groups:') || content.startsWith('port:')) {
    const nodes = parseClashYaml(content, sourceId, sourceName, countryPatterns);
    if (nodes.length > 0) return nodes;
  }

  // 3. Try Base64 decode
  let decoded = content;
  if (!content.includes('://') && !content.includes('\n')) {
    decoded = decodeBase64Safe(content);
  } else if (!content.startsWith('{') && !content.startsWith('proxies:')) {
    // Might be multiline base64 or mixed
    try {
      const b64 = decodeBase64Safe(content);
      if (b64.includes('://')) {
        decoded = b64;
      }
    } catch (e) {}
  }

  // 4. Parse line-by-line URI list
  const lines = decoded.split(/[\r\n]+/).map(l => l.trim()).filter(Boolean);
  const uriNodes: ProxyNode[] = [];
  lines.forEach((line, idx) => {
    let candidate = line;
    // Decode double or single URL-encoded string
    if (candidate.includes('%25')) {
      try {
        candidate = decodeURIComponent(decodeURIComponent(candidate));
      } catch {}
    } else if (candidate.includes('%40') || candidate.includes('%3A')) {
      try {
        candidate = decodeURIComponent(candidate);
      } catch {}
    }

    // Auto-detect missing protocol scheme:
    // e.g. starts with UUID@host:port, or starts with partial uuid like [0-9a-f-]{20,}@
    if (!candidate.includes('://')) {
      if (/^[0-9a-fA-F-]{20,}@/.test(candidate) || (candidate.includes('@') && candidate.includes(':') && candidate.includes('?'))) {
        candidate = `vless://${candidate}`;
      }
    }

    if (candidate.includes('://')) {
      const node = parseNodeUri(candidate, idx, countryPatterns);
      if (node) {
        node.sourceId = sourceId;
        node.sourceName = sourceName;
        node.raw = candidate;
        uriNodes.push(node);
      }
    }
  });

  if (uriNodes.length > 0) {
    return uriNodes;
  }

  // Fallback try YAML / JSON on decoded string
  if (decoded.includes('proxies:')) {
    return parseClashYaml(decoded, sourceId, sourceName, countryPatterns);
  }
  if (decoded.startsWith('{') && decoded.includes('"outbounds"')) {
    return parseSingboxJson(decoded, sourceId, sourceName, countryPatterns);
  }

  return [];
}
